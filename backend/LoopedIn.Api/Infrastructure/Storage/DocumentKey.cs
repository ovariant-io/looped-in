namespace LoopedIn.Api.Infrastructure.Storage;

/// <summary>
/// Builds and parses the S3 keys that back a document, and enforces every rule that keeps one
/// caller's keys from addressing another caller's objects.
/// <para>
/// Layout — <c>{prefix}{ownerId}/{documentId}/{escapedFilename}</c>:
/// </para>
/// <code>
/// documents/user_2abc.../0195f3c1e4a97b3e9d2c8f5a1b6d4e07/Q3%20report.pdf
/// |         |            |                                |
/// |         |            |                                └─ Uri.EscapeDataString(filename):
/// |         |            |                                   round-trips the original exactly
/// |         |            |                                   and can never contain '/', so a
/// |         |            |                                   document is always ONE object.
/// |         |            └─ UUIDv7 in "N" form: the timestamp leads, so listing objects in S3's
/// |         |               lexicographic order is also chronological order.
/// |         └─ the caller's Clerk `sub`. ALWAYS taken from the validated token, never from the
/// |            request — this is the whole tenancy boundary.
/// └─ the configured prefix ("documents/").
/// </code>
/// <para>
/// The filename living in the key (rather than only in <c>x-amz-meta-*</c>) is what makes
/// listing a single S3 call: <c>ListObjectsV2</c> returns keys, sizes, and timestamps but never
/// user metadata, so reading names from metadata would cost one <c>HeadObject</c> per document.
/// </para>
/// </summary>
public static class DocumentKey
{
    /// <summary>Longest accepted filename, in characters, before URL-escaping.</summary>
    public const int MaxFilenameLength = 200;

    /// <summary>Longest accepted owner id. Clerk user ids are far shorter than this.</summary>
    private const int MaxOwnerIdLength = 128;

    /// <summary>Mints a new time-ordered document id.</summary>
    public static string NewId() => Guid.CreateVersion7().ToString("n");

    /// <summary>
    /// Normalizes the configured prefix to the single form the rest of this type assumes:
    /// no leading slash, exactly one trailing slash. A blank prefix yields "documents/".
    /// </summary>
    public static string NormalizePrefix(string? prefix)
    {
        var trimmed = (prefix ?? string.Empty).Trim().Trim('/');
        return trimmed.Length == 0 ? "documents/" : trimmed + "/";
    }

    /// <summary>
    /// True when the owner id is safe to embed in a key. Clerk subjects look like
    /// <c>user_2abc…</c>; anything outside that shape is rejected rather than escaped, because a
    /// surprising subject means something upstream is wrong and a 500 is the honest answer.
    /// </summary>
    public static bool IsValidOwnerId(string? ownerId) =>
        !string.IsNullOrEmpty(ownerId)
        && ownerId.Length <= MaxOwnerIdLength
        && ownerId.All(static c => char.IsAsciiLetterOrDigit(c) || c is '_' or '-');

    /// <summary>
    /// Accepts a client-supplied document id only when it is a well-formed 32-hex-digit GUID,
    /// and returns it lowercased so it matches the stored key byte for byte.
    /// </summary>
    public static bool TryNormalizeId(string? id, out string normalized)
    {
        normalized = string.Empty;
        if (string.IsNullOrWhiteSpace(id) || !Guid.TryParseExact(id, "N", out var parsed))
        {
            return false;
        }

        normalized = parsed.ToString("n");
        return true;
    }

    /// <summary>
    /// Validates a client-supplied filename and strips any directory part. Rejects rather than
    /// silently rewrites, so the caller always gets back exactly the name they asked for.
    /// </summary>
    /// <remarks>
    /// Path stripping here is belt-and-braces: <see cref="Uri.EscapeDataString"/> already turns
    /// a <c>/</c> into <c>%2F</c>, so traversal cannot escape the document's own key segment
    /// even if this check were removed.
    /// </remarks>
    public static bool TryNormalizeFilename(string? filename, out string normalized, out string error)
    {
        normalized = string.Empty;
        error = string.Empty;

        if (string.IsNullOrWhiteSpace(filename))
        {
            error = "A filename is required.";
            return false;
        }

        // Drop any directory component from either separator convention; browsers have been
        // known to send a full path for a dropped file.
        var lastSeparator = filename.LastIndexOfAny(['/', '\\']);
        var candidate = (lastSeparator >= 0 ? filename[(lastSeparator + 1)..] : filename).Trim();

        if (candidate.Length == 0 || candidate is "." or "..")
        {
            error = "A filename is required.";
            return false;
        }

        if (candidate.Length > MaxFilenameLength)
        {
            error = $"Filenames are limited to {MaxFilenameLength} characters.";
            return false;
        }

        if (candidate.Any(char.IsControl))
        {
            error = "Filenames cannot contain control characters.";
            return false;
        }

        normalized = candidate;
        return true;
    }

    /// <summary>The prefix covering every document owned by <paramref name="ownerId"/>.</summary>
    public static string OwnerPrefix(string prefix, string ownerId) => $"{prefix}{ownerId}/";

    /// <summary>The prefix covering the single object that is one document.</summary>
    public static string DocumentPrefix(string prefix, string ownerId, string documentId) =>
        $"{prefix}{ownerId}/{documentId}/";

    /// <summary>The full object key for a document.</summary>
    public static string Build(string prefix, string ownerId, string documentId, string filename) =>
        DocumentPrefix(prefix, ownerId, documentId) + Uri.EscapeDataString(filename);

    /// <summary>
    /// Recovers the document id and original filename from a key, verifying it really does sit
    /// under <paramref name="ownerId"/>'s prefix and has the exact expected shape. Anything else
    /// — a stray object written by hand, a deeper nesting — is reported as unparseable so
    /// listing skips it instead of surfacing something the API cannot address.
    /// </summary>
    public static bool TryParse(
        string prefix,
        string ownerId,
        string key,
        out string documentId,
        out string filename)
    {
        documentId = string.Empty;
        filename = string.Empty;

        var ownerPrefix = OwnerPrefix(prefix, ownerId);
        if (!key.StartsWith(ownerPrefix, StringComparison.Ordinal))
        {
            return false;
        }

        var remainder = key[ownerPrefix.Length..];
        var separator = remainder.IndexOf('/', StringComparison.Ordinal);
        if (separator <= 0 || separator == remainder.Length - 1)
        {
            return false;
        }

        var namePart = remainder[(separator + 1)..];
        // Exactly one object per document: a nested key is not something this API created.
        if (namePart.Contains('/', StringComparison.Ordinal))
        {
            return false;
        }

        if (!TryNormalizeId(remainder[..separator], out var id))
        {
            return false;
        }

        try
        {
            filename = Uri.UnescapeDataString(namePart);
        }
        catch (UriFormatException)
        {
            return false;
        }

        documentId = id;
        return filename.Length > 0;
    }
}
