using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.IdentityModel.Tokens;

namespace LoopedIn.Api.Infrastructure.Authentication;

/// <summary>
/// Composable DI registrations for Clerk-issued JWT bearer authentication.
/// </summary>
public static class AuthenticationServiceCollectionExtensions
{
    /// <summary>
    /// Registers JWT bearer authentication that validates Clerk session tokens against
    /// Clerk's JWKS. Signing keys and the issuer are discovered automatically (OIDC) from
    /// <c>Clerk:Authority</c> — the Clerk <b>Frontend API URL</b>, which on a dev instance
    /// looks like <c>https://&lt;slug&gt;.clerk.accounts.dev</c>. Find it in the Clerk
    /// Dashboard under <i>API Keys</i>.
    /// <para>
    /// Optionally reads <c>Clerk:AuthorizedParties</c> (a comma-separated list) and, when
    /// present, validates each token's <c>azp</c> claim against it.
    /// </para>
    /// <para>
    /// <b>Resilience:</b> when <c>Clerk:Authority</c> is missing or blank the bearer scheme is
    /// still registered so the app boots, but it has no issuer/JWKS to validate against — so
    /// every endpoint marked <c>RequireAuthorization()</c> rejects requests with 401 until the
    /// value is set. A warning is logged in that state.
    /// </para>
    /// </summary>
    public static IServiceCollection AddClerkAuthentication(this IServiceCollection services, IConfiguration configuration)
    {
        var authority = configuration["Clerk:Authority"];
        var authorizedParties = (configuration["Clerk:AuthorizedParties"] ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        if (string.IsNullOrWhiteSpace(authority))
        {
            // No ILogger is resolvable at registration time; use a throwaway bootstrap logger.
            using var loggerFactory = LoggerFactory.Create(builder => builder.AddConsole());
            loggerFactory.CreateLogger("LoopedIn.Api.Authentication").LogWarning(
                "Clerk authentication is not configured (Clerk:Authority is empty). The JWT bearer " +
                "scheme is registered but has no issuer/JWKS to validate against, so endpoints that " +
                "require authorization will reject all requests with 401 until Clerk:Authority is set.");
        }

        services
            .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
            .AddJwtBearer(options =>
            {
                // Clerk's Frontend API URL is both the OIDC authority (for JWKS discovery) and the
                // token issuer. Leaving Authority null when unconfigured keeps the app bootable.
                options.Authority = authority;
                options.RequireHttpsMetadata = true;
                options.TokenValidationParameters = new TokenValidationParameters
                {
                    ValidateIssuer = true,
                    ValidIssuer = authority,
                    // Clerk session tokens carry no fixed audience by default.
                    ValidateAudience = false,
                    ValidateLifetime = true,
                };

                if (authorizedParties.Length > 0)
                {
                    options.Events = new JwtBearerEvents
                    {
                        OnTokenValidated = context =>
                        {
                            var azp = context.Principal?.FindFirst("azp")?.Value;
                            if (string.IsNullOrEmpty(azp) || !authorizedParties.Contains(azp, StringComparer.Ordinal))
                            {
                                context.Fail("The token's authorized party (azp) is not in the configured Clerk:AuthorizedParties allow-list.");
                            }

                            return Task.CompletedTask;
                        },
                    };
                }
            });

        services.AddAuthorization();

        return services;
    }
}
