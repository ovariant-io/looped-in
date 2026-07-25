using System.Security.Claims;
using Amazon.Lambda.AspNetCoreServer.Hosting;
using LoopedIn.Api.Infrastructure.Authentication;
using LoopedIn.Api.Infrastructure.Database;
using LoopedIn.Api.Models;
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

var app = builder.Build();

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

// Connectivity check against Neon Postgres. Returns 503 until DATABASE_URL is set.
app.MapGet("/db/ping", async (IServiceProvider services, CancellationToken cancellationToken) =>
{
    var dataSource = services.GetService<NpgsqlDataSource>();
    if (dataSource is null)
    {
        return Results.Problem(
            "DATABASE_URL is not configured. Set it in backend/.env.local (see .env.local.example).",
            statusCode: StatusCodes.Status503ServiceUnavailable);
    }

    try
    {
        await using var command = dataSource.CreateCommand("select version(), now()");
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        await reader.ReadAsync(cancellationToken);
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
})
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
        });
    }
    catch (Exception ex)
    {
        return Results.Problem(ex.Message, statusCode: StatusCodes.Status503ServiceUnavailable);
    }
})
.WithName("AuthPing");

var summaries = new[]
{
    "Freezing", "Bracing", "Chilly", "Cool", "Mild", "Warm", "Balmy", "Hot", "Sweltering", "Scorching"
};

app.MapGet("/weatherforecast", () =>
{
    var forecast = Enumerable.Range(1, 5).Select(index =>
        new WeatherForecast
        (
            DateOnly.FromDateTime(DateTime.Now.AddDays(index)),
            Random.Shared.Next(-20, 55),
            summaries[Random.Shared.Next(summaries.Length)]
        ))
        .ToArray();
    return forecast;
})
.WithName("GetWeatherForecast");

// Protected endpoint: requires a valid Clerk session JWT. Returns the Clerk user id (sub)
// plus any readily available claims. Returns 401 without a valid token.
app.MapGet("/me", (ClaimsPrincipal user) =>
{
    var userId = user.FindFirstValue(ClaimTypes.NameIdentifier) ?? user.FindFirstValue("sub");
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

app.Run();
