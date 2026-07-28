using Npgsql;

namespace LoopedIn.Api.Infrastructure.Database;

/// <summary>
/// Composable DI registrations for the Neon Postgres data source.
/// </summary>
public static class DatabaseServiceCollectionExtensions
{
    /// <summary>
    /// Registers a pooled <see cref="NpgsqlDataSource"/> when <paramref name="databaseUrl"/>
    /// is configured. Accepts either Neon's <c>postgresql://</c> URL or a native Npgsql
    /// key/value connection string. When the value is null or blank the data source is left
    /// unregistered, so the API still starts and <c>/db/ping</c> reports 503.
    /// <para>
    /// A <see cref="DatabaseState"/> is registered on <em>both</em> branches. It cannot be
    /// registered later: migrations run after <c>builder.Build()</c> has sealed the container, so
    /// the holder has to exist before the outcome does. See <see cref="DatabaseState"/>.
    /// </para>
    /// </summary>
    public static IServiceCollection AddNeonDatabase(this IServiceCollection services, string? databaseUrl)
    {
        if (string.IsNullOrWhiteSpace(databaseUrl))
        {
            return services.AddSingleton(new DatabaseState(
                "DATABASE_URL is not configured. Set it in backend/.env.local (see .env.local.example), "
                    + "or deploy the stack, which passes it in."));
        }

        try
        {
            services.AddSingleton(NpgsqlDataSource.Create(DbBootstrap.ToNpgsqlConnectionString(databaseUrl)));

            // Registered only on this branch, so they are never resolvable when there is no
            // database to talk to. Routes reach them through DatabaseGateFilter, which answers
            // 503 first.
            services.AddSingleton<ClientStore>();
            services.AddSingleton<CampaignStore>();
        }
        catch (Exception ex)
        {
            // A malformed DATABASE_URL must not take the whole API down with it — /documents and
            // /me have nothing to do with Postgres. Degrade the way an unconfigured value does.
            using var loggerFactory = LoggerFactory.Create(builder => builder.AddConsole());
            loggerFactory.CreateLogger("LoopedIn.Api.Database").LogWarning(
                "DATABASE_URL could not be parsed ({Reason}). Database-backed routes will report 503.",
                ex.Message);

            return services.AddSingleton(new DatabaseState(
                $"DATABASE_URL could not be parsed: {ex.Message}. Expected Neon's postgresql:// URL or a "
                    + "native Npgsql key/value connection string."));
        }

        // Starts unavailable and is flipped by the migrator: a schema nobody has confirmed is
        // migrated is not one to serve CRUD against.
        return services.AddSingleton(new DatabaseState(
            "The database has not finished starting up. Migrations run during startup — if this "
                + "persists, the API logs carry the reason."));
    }
}
