using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using Npgsql;

namespace LoopedIn.Api.Infrastructure.Database;

/// <summary>One migration file, as embedded in the assembly.</summary>
/// <param name="Id">The file name without its <c>.sql</c> suffix, e.g. <c>0001_clients_contacts</c>.</param>
/// <param name="Sql">The statements to run, already newline-normalized.</param>
/// <param name="Checksum">Lowercase hex SHA-256 of <paramref name="Sql"/>.</param>
public sealed record Migration(string Id, string Sql, string Checksum);

/// <summary>
/// What a boot needs to do, decided purely from the embedded files and the journal contents.
/// </summary>
/// <remarks>
/// Split out from <see cref="DatabaseMigrator"/> as argument-in/result-out logic with no database
/// in sight, because this is the part with the interesting decisions in it — and so it is
/// unit-testable the day this repo grows a test project (see the plan's §10).
/// </remarks>
public sealed record MigrationPlan(IReadOnlyList<Migration> Pending, string? ChecksumError)
{
    /// <summary>
    /// Compares the embedded files against the journal. Returns the files still to apply, or a
    /// non-null <see cref="ChecksumError"/> if an already-applied file has been edited since.
    /// </summary>
    /// <param name="orphaned">
    /// Journal entries with no matching file — a deleted migration, or more commonly a rollback
    /// to an older build. Reported so the caller can warn; deliberately <em>not</em> an error,
    /// because refusing to boot during a rollback is worse than the drift it would catch.
    /// </param>
    public static MigrationPlan Create(
        IReadOnlyList<Migration> available,
        IReadOnlyDictionary<string, string> applied,
        out IReadOnlyList<string> orphaned)
    {
        var known = new HashSet<string>(available.Select(migration => migration.Id), StringComparer.Ordinal);
        orphaned = applied.Keys.Where(id => !known.Contains(id)).Order(StringComparer.Ordinal).ToArray();

        var pending = new List<Migration>();
        foreach (var migration in available)
        {
            if (!applied.TryGetValue(migration.Id, out var recorded))
            {
                pending.Add(migration);
                continue;
            }

            if (!string.Equals(recorded, migration.Checksum, StringComparison.Ordinal))
            {
                return new MigrationPlan([], ChecksumMismatch(migration.Id, recorded, migration.Checksum));
            }
        }

        return new MigrationPlan(pending, null);
    }

    internal static string ChecksumMismatch(string id, string recorded, string actual) =>
        $"Migration '{id}' has changed since it was applied to this database (recorded checksum "
            + $"{recorded[..12]}…, file is {actual[..12]}…). Applied migrations are append-only — the "
            + "deployed schema and the repository now disagree about what was run. Restore the original "
            + "file and add a new migration for the change.";
}

/// <summary>
/// Applies the embedded <c>Migrations/*.sql</c> files to Postgres at startup. See
/// <c>Migrations/README.md</c> for the contract this enforces.
/// </summary>
internal sealed class DatabaseMigrator
{
    /// <summary>
    /// MSBuild derives resource names from <c>RootNamespace</c> plus the folder path, so this
    /// tracks the directory layout rather than the C# namespace. <see cref="LoadEmbedded"/>
    /// treats "no files found" as a hard error precisely because a drift here would otherwise
    /// look exactly like "nothing to migrate".
    /// </summary>
    private const string ResourcePrefix = "LoopedIn.Api.Infrastructure.Database.Migrations.";

    private const string AdvisoryLockKey = "looped_in_migrations";

    /// <summary>
    /// Bounds every command. The whole point of degrading to a 503 on failure is that a boot
    /// fails <em>fast</em>: without this a hung connection wedges startup instead of reporting.
    /// </summary>
    private const int CommandTimeoutSeconds = 30;

    private readonly NpgsqlDataSource _dataSource;
    private readonly IReadOnlyList<Migration> _migrations;
    private readonly ILogger _logger;

    public DatabaseMigrator(NpgsqlDataSource dataSource, IReadOnlyList<Migration> migrations, ILogger logger)
    {
        _dataSource = dataSource;
        _migrations = migrations;
        _logger = logger;
    }

    /// <summary>
    /// Reads every <c>Migrations/*.sql</c> embedded in <paramref name="assembly"/>, in ordinal
    /// name order — which is why the four-digit zero-padded prefix matters.
    /// </summary>
    public static IReadOnlyList<Migration> LoadEmbedded(Assembly assembly)
    {
        var names = assembly.GetManifestResourceNames()
            .Where(name => name.StartsWith(ResourcePrefix, StringComparison.Ordinal)
                && name.EndsWith(".sql", StringComparison.Ordinal))
            .Order(StringComparer.Ordinal)
            .ToArray();

        if (names.Length == 0)
        {
            throw new InvalidOperationException(
                $"No migrations are embedded under '{ResourcePrefix}'. Check that the EmbeddedResource "
                    + "item for Infrastructure/Database/Migrations/*.sql is still in LoopedIn.Api.csproj.");
        }

        var migrations = new List<Migration>(names.Length);
        foreach (var name in names)
        {
            using var stream = assembly.GetManifestResourceStream(name)
                ?? throw new InvalidOperationException($"Embedded migration '{name}' could not be opened.");

            // detectEncodingFromByteOrderMarks strips a BOM, which would otherwise change the
            // checksum without changing a single statement.
            using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
            var sql = Normalize(reader.ReadToEnd());

            var id = name[ResourcePrefix.Length..^".sql".Length];
            migrations.Add(new Migration(id, sql, Checksum(sql)));
        }

        return migrations;
    }

    /// <summary>Applies whatever is pending. Returns the number of files applied by this process.</summary>
    public async Task<int> RunAsync(CancellationToken cancellationToken)
    {
        var applied = await ReadJournalAsync(cancellationToken);
        var plan = MigrationPlan.Create(_migrations, applied, out var orphaned);

        if (plan.ChecksumError is { } error)
        {
            throw new InvalidOperationException(error);
        }

        if (orphaned.Count > 0)
        {
            _logger.LogWarning(
                "The database records migrations this build does not contain ({Orphaned}). That is "
                    + "expected during a rollback, and drift otherwise.",
                string.Join(", ", orphaned));
        }

        if (plan.Pending.Count == 0)
        {
            // The warm path, and the reason the journal read happens before any locking: a Lambda
            // cold start against an already-migrated database costs one round-trip and takes no lock.
            return 0;
        }

        await EnsureJournalAsync(cancellationToken);

        var count = 0;
        foreach (var migration in plan.Pending)
        {
            if (await ApplyAsync(migration, cancellationToken))
            {
                _logger.LogInformation("Applied migration {Migration}.", migration.Id);
                count++;
            }
            else
            {
                _logger.LogInformation(
                    "Migration {Migration} was applied concurrently by another instance.", migration.Id);
            }
        }

        return count;
    }

    /// <summary>
    /// Reads the journal, treating "the table does not exist yet" as "nothing has been applied".
    /// </summary>
    private async Task<IReadOnlyDictionary<string, string>> ReadJournalAsync(CancellationToken cancellationToken)
    {
        var applied = new Dictionary<string, string>(StringComparer.Ordinal);

        try
        {
            await using var command = _dataSource.CreateCommand("select id, checksum from schema_migrations");
            command.CommandTimeout = CommandTimeoutSeconds;
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                applied[reader.GetString(0)] = reader.GetString(1);
            }
        }
        catch (PostgresException ex) when (ex.SqlState == PostgresErrorCodes.UndefinedTable)
        {
            // First run against this database.
        }

        return applied;
    }

    /// <summary>
    /// Creates the journal under the advisory lock. Concurrent <c>create table if not exists</c>
    /// is not actually safe in Postgres — two sessions racing it can fail on the internal catalog
    /// unique index — so this takes the same lock everything else does rather than relying on the
    /// <c>if not exists</c> alone.
    /// </summary>
    private async Task EnsureJournalAsync(CancellationToken cancellationToken)
    {
        await using var connection = await _dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

        await LockAsync(connection, transaction, cancellationToken);
        await ExecuteAsync(
            connection,
            transaction,
            """
            create table if not exists schema_migrations (
                id          text        primary key,
                checksum    text        not null,
                applied_at  timestamptz not null default now()
            )
            """,
            cancellationToken);

        await transaction.CommitAsync(cancellationToken);
    }

    /// <summary>
    /// Applies one file inside a single transaction holding the advisory lock. Returns false when
    /// another instance had already applied it — the losers of a concurrent-cold-start race.
    /// </summary>
    private async Task<bool> ApplyAsync(Migration migration, CancellationToken cancellationToken)
    {
        await using var connection = await _dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

        await LockAsync(connection, transaction, cancellationToken);

        // Re-read under the lock. Between the journal read above and this point another instance
        // may have applied the very file we are holding.
        string? recorded;
        await using (var check = new NpgsqlCommand(
            "select checksum from schema_migrations where id = @id", connection, transaction))
        {
            check.CommandTimeout = CommandTimeoutSeconds;
            check.Parameters.AddWithValue("id", migration.Id);
            recorded = await check.ExecuteScalarAsync(cancellationToken) as string;
        }

        if (recorded is not null)
        {
            await transaction.CommitAsync(cancellationToken);
            return string.Equals(recorded, migration.Checksum, StringComparison.Ordinal)
                ? false
                : throw new InvalidOperationException(
                    MigrationPlan.ChecksumMismatch(migration.Id, recorded, migration.Checksum));
        }

        await ExecuteAsync(connection, transaction, migration.Sql, cancellationToken);

        await using (var record = new NpgsqlCommand(
            "insert into schema_migrations (id, checksum) values (@id, @checksum)", connection, transaction))
        {
            record.CommandTimeout = CommandTimeoutSeconds;
            record.Parameters.AddWithValue("id", migration.Id);
            record.Parameters.AddWithValue("checksum", migration.Checksum);
            await record.ExecuteNonQueryAsync(cancellationToken);
        }

        await transaction.CommitAsync(cancellationToken);
        return true;
    }

    /// <summary>
    /// Takes the migration lock for the life of the transaction.
    /// </summary>
    /// <remarks>
    /// Transaction-scoped (<c>pg_advisory_xact_lock</c>), never session-scoped
    /// (<c>pg_advisory_lock</c>), and that is the load-bearing detail: a session lock silently
    /// stops providing mutual exclusion through PgBouncer transaction pooling — which is exactly
    /// what Neon's pooled endpoint is — because acquire and release can land on different server
    /// connections. Inside an explicit transaction this pins one server connection for its
    /// duration, so it holds on the pooled endpoint, the direct endpoint, and under Npgsql's own
    /// pooling, where each command otherwise draws a fresh connection.
    /// </remarks>
    private static async Task LockAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand(
            "select pg_advisory_xact_lock(hashtext(@key)::bigint)", connection, transaction);
        command.CommandTimeout = CommandTimeoutSeconds;
        command.Parameters.AddWithValue("key", AdvisoryLockKey);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task ExecuteAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        string sql,
        CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand(sql, connection, transaction);
        command.CommandTimeout = CommandTimeoutSeconds;
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    /// <summary>
    /// Normalizes line endings before hashing. Without this, a checkout with CRLF translation
    /// would produce a different checksum for a byte-identical schema and hard-fail startup on
    /// that machine — a false positive that has nothing to do with the SQL.
    /// </summary>
    private static string Normalize(string sql) => sql.ReplaceLineEndings("\n");

    private static string Checksum(string sql) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(sql)));
}

/// <summary>Startup wiring for <see cref="DatabaseMigrator"/>.</summary>
public static class DatabaseMigrationExtensions
{
    /// <summary>
    /// Applies pending migrations, recording the outcome in <see cref="DatabaseState"/>.
    /// </summary>
    /// <remarks>
    /// Never throws. A migration failure leaves the app booting and every database-backed route
    /// answering 503 with the reason — the same degradation unconfigured storage has. The rest of
    /// the API is unaffected by a database problem, but serving CRUD against a half-migrated
    /// schema would be worse than serving nothing.
    /// </remarks>
    public static async Task MigrateDatabaseAsync(
        this IServiceProvider services,
        CancellationToken cancellationToken = default)
    {
        var state = services.GetRequiredService<DatabaseState>();
        var dataSource = services.GetService<NpgsqlDataSource>();
        var logger = services.GetRequiredService<ILoggerFactory>().CreateLogger("LoopedIn.Api.Database");

        if (dataSource is null)
        {
            // Unconfigured. DatabaseState already carries the reason AddNeonDatabase set, and
            // saying it again at Warning on every boot would just be noise.
            logger.LogInformation("Skipping migrations: {Reason}", state.Reason);
            return;
        }

        try
        {
            var migrator = new DatabaseMigrator(
                dataSource, DatabaseMigrator.LoadEmbedded(typeof(DatabaseMigrator).Assembly), logger);

            var applied = await migrator.RunAsync(cancellationToken);
            state.MarkAvailable();

            logger.LogInformation(
                applied == 0 ? "Database schema is up to date." : "Applied {Count} migration(s).", applied);
        }
        catch (Exception ex)
        {
            var reason = $"The database schema could not be migrated: {ex.Message}";
            state.MarkUnavailable(reason);
            logger.LogError(
                ex,
                "Database migration failed. The API will start, but /db/ping and every database-backed "
                    + "route will report 503 until this is resolved.");
        }
    }
}
