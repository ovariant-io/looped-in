namespace LoopedIn.Api.Infrastructure.Database;

/// <summary>
/// Whether the database is usable, and why not when it isn't.
/// </summary>
/// <remarks>
/// A <em>mutable</em> singleton holder rather than an immutable record like
/// <see cref="Storage.DocumentStorageStatus"/>, and the difference is forced by timing rather
/// than taste: storage's status is known at registration time, but a migration outcome only
/// exists <em>after</em> <c>builder.Build()</c> has sealed the DI container. There is no way to
/// register a status that a post-build failure produces, so the holder is registered on both
/// branches of <c>AddNeonDatabase</c> and written to once the migrator has run.
/// <para>
/// It starts unavailable. A database nobody has confirmed is reachable is not one to serve CRUD
/// against, so the failure direction is the default.
/// </para>
/// </remarks>
public sealed class DatabaseState
{
    private volatile string? _reason;

    /// <param name="reason">Why the database is unavailable at startup — typically the
    /// "DATABASE_URL is not configured" message, replaced by the migrator's own outcome.</param>
    public DatabaseState(string reason)
    {
        _reason = reason;
    }

    /// <summary>True once migrations have completed successfully.</summary>
    public bool Available => _reason is null;

    /// <summary>The reason the database is unusable, or null when it is fine.</summary>
    public string? Reason => _reason;

    /// <summary>Marks the database ready. Called by the migrator after the last file applies.</summary>
    public void MarkAvailable() => _reason = null;

    /// <summary>Marks the database unusable with a caller-facing reason.</summary>
    public void MarkUnavailable(string reason) => _reason = reason;
}
