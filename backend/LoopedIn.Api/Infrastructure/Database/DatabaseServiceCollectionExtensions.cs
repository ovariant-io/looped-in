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
    /// </summary>
    public static IServiceCollection AddNeonDatabase(this IServiceCollection services, string? databaseUrl)
    {
        if (!string.IsNullOrWhiteSpace(databaseUrl))
        {
            var connectionString = DbBootstrap.ToNpgsqlConnectionString(databaseUrl);
            services.AddSingleton(NpgsqlDataSource.Create(connectionString));
        }

        return services;
    }
}
