namespace LoopedIn.Api.Models;

/// <summary>
/// A document as it appears in a listing. Deliberately carries only what S3's
/// <c>ListObjectsV2</c> returns for free — content type is absent because it lives in object
/// metadata, which listing does not return, and fetching it would cost one <c>HeadObject</c> per
/// row. Clients that need it read <see cref="DocumentDetail"/> for the one document they care
/// about; a list UI can label rows from the filename extension.
/// </summary>
public sealed record DocumentSummary(
    string Id,
    string Filename,
    long Size,
    DateTimeOffset LastModified);

/// <summary>One document, including the authoritative content type stored on the object.</summary>
public sealed record DocumentDetail(
    string Id,
    string Filename,
    long Size,
    DateTimeOffset LastModified,
    string ContentType,
    string? ETag);

/// <summary>
/// A page of documents. <paramref name="Truncated"/> is true when the owner has more objects
/// than this API will enumerate in one request, so a UI can say so rather than quietly
/// presenting a partial list as complete.
/// </summary>
public sealed record DocumentListResponse(
    IReadOnlyList<DocumentSummary> Documents,
    bool Truncated);

/// <summary>
/// Body of <c>POST /documents</c> — the intent to upload, before any bytes exist.
/// <para>
/// <paramref name="Size"/> is the byte length the client is about to PUT. It is required so
/// the API can refuse an oversized upload before signing anything; see
/// <see cref="Infrastructure.Storage.DocumentStorageOptions.MaxUploadBytes"/> for why that is
/// an advisory check rather than an enforced one.
/// </para>
/// </summary>
public sealed record CreateDocumentRequest(string? Filename, string? ContentType, long? Size);

/// <summary>
/// The presigned upload target. The client must PUT to <paramref name="UploadUrl"/> sending
/// <paramref name="RequiredHeaders"/> verbatim — those headers are part of the signature, so a
/// different value (or an omitted one) makes S3 reject the request with 403.
/// </summary>
public sealed record CreateDocumentResponse(
    string Id,
    string Filename,
    string UploadUrl,
    IReadOnlyDictionary<string, string> RequiredHeaders,
    DateTimeOffset ExpiresAt);

/// <summary>Body of <c>PATCH /documents/{id}</c>.</summary>
public sealed record RenameDocumentRequest(string? Filename);

/// <summary>A presigned, short-lived download URL for one document.</summary>
public sealed record DocumentContentResponse(
    string Id,
    string Filename,
    string ContentType,
    string DownloadUrl,
    DateTimeOffset ExpiresAt);
