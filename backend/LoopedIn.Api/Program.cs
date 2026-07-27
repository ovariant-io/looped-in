using System.Security.Claims;
using Amazon.Lambda.AspNetCoreServer.Hosting;
using LoopedIn.Api.Endpoints;
using LoopedIn.Api.Infrastructure.Authentication;
using LoopedIn.Api.Infrastructure.Database;
using LoopedIn.Api.Infrastructure.Diagnostics;
using LoopedIn.Api.Infrastructure.Http;
using LoopedIn.Api.Infrastructure.Storage;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.Extensions.Options;
using Npgsql;

// Load DATABASE_URL, Clerk__Authority (and friends) from a gitignored .env.local during local
// dev BEFORE the builder is created, so the values are present when the environment-variable
// configuration provider snapshots the process environment (and thus flow into IConfiguration).
// In containers the values are injected as real environment variables instead, so this no-ops.
DbBootstrap.LoadDotEnvLocal(Directory.GetCurrentDirectory());

var builder = WebApplication.CreateBuilder(args);

// Run as an AWS Lambda when deployed (Function URL → API Gateway v2 / HttpApi payload format).
// This is a NO-OP outside Lambda — it only takes effect when the Lambda runtime env vars are
// present — so local `dotnet run` and the Docker/Compose image keep using Kestrel unchanged.
builder.Services.AddAWSLambdaHosting(LambdaEventSource.HttpApi);

// Add services to the container.
// Learn more about configuring OpenAPI at https://aka.ms/aspnet/openapi
builder.Services.AddOpenApi();

// Register a pooled Npgsql data source when DATABASE_URL is configured.
// Neon shows a postgresql:// URL; we accept that or a native Npgsql key/value string.
builder.Services.AddNeonDatabase(Environment.GetEnvironmentVariable("DATABASE_URL"));

// Validate Clerk-issued session JWTs against Clerk's JWKS (discovered from Clerk:Authority).
// No-ops gracefully when Clerk:Authority is unset: the app still boots, but protected
// endpoints reject all requests until it is configured.
builder.Services.AddClerkAuthentication(builder.Configuration);

// S3-backed document storage. Degrades the same way as the two above: without Documents:Bucket
// the app still boots and the /documents endpoints report 503 with the reason.
builder.Services.AddDocumentStorage(builder.Configuration);

// Collapses repeated hits on the public */ping checks into one backend call per few seconds,
// so an unauthenticated caller cannot drive unbounded Neon/S3 work. See ProbeCache.
builder.Services.AddSingleton<ProbeCache>();

var app = builder.Build();

// Apply pending schema migrations before serving anything. A no-op when DATABASE_URL is unset,
// and never fatal: a failure is recorded in DatabaseState, so the app still boots and every
// database-backed route reports 503 with the reason. See Infrastructure/Database/Migrations/README.md.
await app.Services.MigrateDatabaseAsync();

// Configure the HTTP request pipeline.
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

app.UseHttpsRedirection();

app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/", () => "Hello World from LoopedIn.Api (.NET 10)")
    .WithName("GetHello");

// Connectivity check against Neon Postgres. Returns 503 until DATABASE_URL is set, and — since
// migrations run at startup — also when the schema could not be migrated, which is the only
// place that failure is visible from outside the logs.
// Public, so the result is cached briefly (ProbeCache) — the query is real work an anonymous
// caller would otherwise be able to repeat as fast as the gateway allows.
app.MapGet("/db/ping", (IServiceProvider services, ProbeCache probes) =>
    probes.GetOrProbeAsync("db", async () =>
    {
        var state = services.GetRequiredService<DatabaseState>();
        var dataSource = services.GetService<NpgsqlDataSource>();
        if (dataSource is null || !state.Available)
        {
            return Results.Problem(
                state.Reason ?? "The database is unavailable.",
                statusCode: StatusCodes.Status503ServiceUnavailable);
        }

        try
        {
            // Deliberately NOT the request's CancellationToken: this task is shared by every
            // caller that arrives during the TTL, so one client disconnecting must not cancel
            // the probe the others are awaiting. The command timeout bounds it instead.
            await using var command = dataSource.CreateCommand("select version(), now()");
            await using var reader = await command.ExecuteReaderAsync(CancellationToken.None);
            await reader.ReadAsync(CancellationToken.None);
            return Results.Ok(new
            {
                connected = true,
                version = reader.GetString(0),
                serverTime = reader.GetFieldValue<DateTime>(1),
            });
        }
        catch (Exception ex)
        {
            return Results.Problem(ex.Message, statusCode: StatusCodes.Status503ServiceUnavailable);
        }
    }))
.WithName("DbPing");

// Connectivity check against Clerk's OIDC/JWKS discovery, using the SAME ConfigurationManager
// the JwtBearer handler relies on so it validates the real auth path. Returns 503 until
// Clerk:Authority is set, or if discovery cannot be reached.
app.MapGet("/auth/ping", async (
    IConfiguration configuration,
    IOptionsMonitor<JwtBearerOptions> jwtOptions,
    CancellationToken cancellationToken) =>
{
    var authority = configuration["Clerk:Authority"];
    if (string.IsNullOrWhiteSpace(authority))
    {
        return Results.Problem(
            "Clerk:Authority is not configured. Set Clerk__Authority in backend/.env.local (the Clerk Frontend API URL).",
            statusCode: StatusCodes.Status503ServiceUnavailable);
    }

    var options = jwtOptions.Get(JwtBearerDefaults.AuthenticationScheme);
    if (options.ConfigurationManager is null)
    {
        return Results.Problem(
            "Clerk OIDC discovery is unavailable: the JwtBearer ConfigurationManager was not initialized (Clerk:Authority may have been unset at startup).",
            statusCode: StatusCodes.Status503ServiceUnavailable);
    }

    // Surfaced because an empty list is a real, invisible weakness rather than a neutral
    // default: audience validation is off (Clerk session tokens carry no fixed `aud`), so with
    // no authorized-party allow-list the API accepts ANY token this Clerk instance issued —
    // including one minted for a third-party OAuth client that self-registered through Dynamic
    // Client Registration and got a user to click Allow. Naming the origins in
    // Clerk__AuthorizedParties is what narrows that to your own apps.
    var authorizedParties = (configuration["Clerk:AuthorizedParties"] ?? string.Empty)
        .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    try
    {
        var oidc = await options.ConfigurationManager.GetConfigurationAsync(cancellationToken);
        return Results.Ok(new
        {
            configured = true,
            authority,
            issuer = oidc.Issuer,
            jwksUri = oidc.JwksUri,
            signingKeys = oidc.SigningKeys.Count,
            authorizedParties,
            authorizedPartiesWarning = authorizedParties.Length == 0
                ? "Clerk:AuthorizedParties is unset, so every token issued by this Clerk instance is "
                    + "accepted (audience validation is off by design). Set Clerk__AuthorizedParties to "
                    + "the origins allowed to call this API."
                : null,
        });
    }
    catch (Exception ex)
    {
        return Results.Problem(ex.Message, statusCode: StatusCodes.Status503ServiceUnavailable);
    }
})
.WithName("AuthPing");

// Protected endpoint: requires a valid Clerk session JWT. Returns the Clerk user id (sub)
// plus any readily available claims. Returns 401 without a valid token.
app.MapGet("/me", (ClaimsPrincipal user) =>
{
    var userId = user.GetSubject();
    var email = user.FindFirstValue(ClaimTypes.Email) ?? user.FindFirstValue("email");

    return Results.Ok(new
    {
        userId,
        email,
        claims = user.Claims.Select(claim => new { claim.Type, claim.Value }),
    });
})
.RequireAuthorization()
.WithName("GetMe");

// Document CRUD over S3 (GET/POST /documents, …). Mapped from its own module rather than
// inline: it is eight routes with real request/response shapes, and keeping them together
// makes the tenancy rule — every key derives from the caller's token — reviewable in one place.
app.MapDocumentEndpoints();

// CRUD over the shared client list in Neon (GET/POST /clients, contacts, …). Unlike documents,
// these rows belong to the team rather than to a user — see ClientEndpoints for what that costs.
app.MapClientEndpoints();

app.Run();
