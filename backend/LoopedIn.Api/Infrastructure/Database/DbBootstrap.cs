using Npgsql;

namespace LoopedIn.Api.Infrastructure.Database;

/// <summary>
/// Local database bootstrapping helpers: loading a gitignored <c>.env.local</c> during
/// development, and normalizing a <c>DATABASE_URL</c> into a native Npgsql connection string.
/// </summary>
internal static class DbBootstrap
{
    // Walk up from the app base dir, content root, and cwd to find a gitignored
    // .env.local and load it into the process environment. No-op when absent
    // (e.g. inside the container, where DATABASE_URL is injected directly).
    public static void LoadDotEnvLocal(string contentRootPath)
    {
        foreach (var start in new[] { AppContext.BaseDirectory, contentRootPath, Directory.GetCurrentDirectory() })
        {
            for (var dir = new DirectoryInfo(start); dir is not null; dir = dir.Parent)
            {
                var path = Path.Combine(dir.FullName, ".env.local");
                if (File.Exists(path))
                {
                    DotNetEnv.Env.Load(path);
                    return;
                }
            }
        }
    }

    // Accept either Neon's postgresql:// URL or a native Npgsql key/value string.
    public static string ToNpgsqlConnectionString(string value)
    {
        if (!value.StartsWith("postgres://", StringComparison.OrdinalIgnoreCase) &&
            !value.StartsWith("postgresql://", StringComparison.OrdinalIgnoreCase))
        {
            return value; // already a native Npgsql connection string
        }

        var uri = new Uri(value);
        var userInfo = uri.UserInfo.Split(':', 2);

        var sslMode = SslMode.Require; // Neon requires TLS; default to it
        foreach (var pair in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var kv = pair.Split('=', 2);
            if (kv.Length == 2 && kv[0].Equals("sslmode", StringComparison.OrdinalIgnoreCase))
            {
                sslMode = kv[1].ToLowerInvariant() switch
                {
                    "disable" => SslMode.Disable,
                    "allow" => SslMode.Allow,
                    "prefer" => SslMode.Prefer,
                    "require" => SslMode.Require,
                    "verify-ca" => SslMode.VerifyCA,
                    "verify-full" => SslMode.VerifyFull,
                    _ => SslMode.Require,
                };
            }
        }

        var connectionBuilder = new NpgsqlConnectionStringBuilder
        {
            Host = uri.Host,
            Port = uri.Port > 0 ? uri.Port : 5432,
            Username = Uri.UnescapeDataString(userInfo[0]),
            Password = userInfo.Length > 1 ? Uri.UnescapeDataString(userInfo[1]) : null,
            Database = uri.AbsolutePath.Trim('/'),
            SslMode = sslMode,
        };
        return connectionBuilder.ConnectionString;
    }
}
