namespace LoopedIn.Api.Infrastructure.Storage;

/// <summary>
/// Resolved document-storage configuration. Only constructed when a bucket is actually
/// configured, so every property here is known-good by the time <see cref="DocumentStore"/>
/// sees it.
/// </summary>
public sealed record DocumentStorageOptions
{
    /// <summary>Configuration section: <c>Documents:Bucket</c>, <c>Documents:Prefix</c>.</summary>
    public const string SectionName = "Documents";

    /// <summary>The S3 bucket holding every document. From <c>Documents:Bucket</c>.</summary>
    public required string Bucket { get; init; }

    /// <summary>Key prefix, normalized to end in "/". From <c>Documents:Prefix</c>, default "documents/".</summary>
    public required string Prefix { get; init; }

    /// <summary>
    /// How long an upload URL stays valid. Long enough for a slow connection to finish a large
    /// file, short enough that a leaked URL is a small window. Presigned URLs inherit the
    /// signer's credentials, and on Lambda those are temporary — keeping this well under an hour
    /// also keeps it well inside the function's credential lifetime.
    /// </summary>
    public TimeSpan UploadUrlLifetime { get; init; } = TimeSpan.FromMinutes(15);

    /// <summary>How long a download URL stays valid — only needs to survive a click.</summary>
    public TimeSpan DownloadUrlLifetime { get; init; } = TimeSpan.FromMinutes(5);

    /// <summary>
    /// Hard ceiling on how many objects one listing will enumerate. A runaway guard, not a page
    /// size: below it the caller always sees their complete library, and past it the response is
    /// flagged truncated (see <see cref="DocumentStore.ListAsync"/> for what that costs).
    /// </summary>
    public int MaxListedObjects { get; init; } = 1000;
}

/// <summary>
/// Whether document storage came up, and why not when it didn't. Registered unconditionally so
/// <c>GET /documents/ping</c> can explain an unconfigured deployment instead of 500ing — the
/// same graceful-degradation contract <c>/db/ping</c> and <c>/auth/ping</c> follow.
/// </summary>
public sealed record DocumentStorageStatus(
    bool Configured,
    string? Bucket,
    string? Prefix,
    string? Reason);
