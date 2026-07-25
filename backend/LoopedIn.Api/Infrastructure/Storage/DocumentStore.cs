using System.Net;
using Amazon.S3;
using Amazon.S3.Model;
using LoopedIn.Api.Models;

namespace LoopedIn.Api.Infrastructure.Storage;

/// <summary>
/// The single seam between the API and S3. Every method takes the owner id as its first argument
/// and derives the key from it via <see cref="DocumentKey"/>, so no call path exists that could
/// address an object outside the caller's own prefix — a client never supplies a key, only a
/// document id, and that id is only ever combined with the owner from the validated token.
/// <para>
/// Bytes never pass through here. Uploads and downloads are presigned URLs the browser uses
/// directly against S3, which keeps large files clear of the API Gateway 10 MB request cap and
/// the Lambda payload limit. This type only ever moves metadata.
/// </para>
/// </summary>
public sealed class DocumentStore(IAmazonS3 s3, DocumentStorageOptions options)
{
    /// <summary>Header name S3 requires the client to echo on a presigned PUT.</summary>
    private const string ContentTypeHeader = "Content-Type";

    /// <summary>What an object gets when the client offers no usable content type.</summary>
    private const string DefaultContentType = "application/octet-stream";

    /// <summary>
    /// Largest upload this store will sign. Exposed so the endpoint can reject an oversized
    /// request — and name the limit in the error — before any S3 work happens. See
    /// <see cref="DocumentStorageOptions.MaxUploadBytes"/> for the (important) caveat that
    /// this bound is advisory rather than enforced by S3.
    /// </summary>
    public long MaxUploadBytes => options.MaxUploadBytes;

    /// <summary>
    /// Proves the bucket is reachable and the role can list it, exercising the same permission
    /// the real endpoints need. Throws whatever S3 threw so the caller can report the reason.
    /// </summary>
    public async Task CheckAsync(CancellationToken cancellationToken)
    {
        await s3.ListObjectsV2Async(
            new ListObjectsV2Request
            {
                BucketName = options.Bucket,
                Prefix = options.Prefix,
                MaxKeys = 1,
            },
            cancellationToken);
    }

    /// <summary>
    /// Lists a caller's documents, newest first.
    /// <para>
    /// S3 enumerates keys in ascending lexicographic order and offers no reverse listing. Because
    /// document ids are UUIDv7 — timestamp first — that order is chronological, so this pages
    /// through the owner's whole prefix and reverses in memory. Under
    /// <see cref="DocumentStorageOptions.MaxListedObjects"/> that is exactly one S3 call and a
    /// complete, correctly ordered list. Past it the response is flagged truncated, and what
    /// comes back is the <em>oldest</em> N — the point at which this needs real cursor
    /// pagination rather than a bigger ceiling.
    /// </para>
    /// </summary>
    public async Task<DocumentListResponse> ListAsync(string ownerId, CancellationToken cancellationToken)
    {
        var prefix = DocumentKey.OwnerPrefix(options.Prefix, ownerId);
        var documents = new List<DocumentSummary>();
        string? continuationToken = null;
        var truncated = false;

        do
        {
            var response = await s3.ListObjectsV2Async(
                new ListObjectsV2Request
                {
                    BucketName = options.Bucket,
                    Prefix = prefix,
                    ContinuationToken = continuationToken,
                },
                cancellationToken);

            foreach (var item in response.S3Objects ?? [])
            {
                // Checked BEFORE adding, not after: reaching the ceiling only means the list
                // is truncated if there is still an object left over. Testing after the add
                // would flag an owner with exactly MaxListedObjects documents as truncated
                // and have the UI claim there is more to see when there isn't.
                if (documents.Count >= options.MaxListedObjects)
                {
                    truncated = true;
                    break;
                }

                if (item.Key is null
                    || !DocumentKey.TryParse(options.Prefix, ownerId, item.Key, out var id, out var filename))
                {
                    // Not something this API wrote (hand-placed object, unexpected nesting).
                    // Skipping keeps one stray key from breaking the whole listing.
                    continue;
                }

                documents.Add(new DocumentSummary(
                    id,
                    filename,
                    item.Size ?? 0,
                    ToUtc(item.LastModified)));
            }

            continuationToken = truncated ? null : response.NextContinuationToken;
        }
        while (!truncated && !string.IsNullOrEmpty(continuationToken));

        // Ids are time-ordered, so ordinal descending is newest-first without re-reading timestamps.
        documents.Sort(static (left, right) => string.CompareOrdinal(right.Id, left.Id));

        return new DocumentListResponse(documents, truncated);
    }

    /// <summary>
    /// Reserves an id and returns a presigned PUT the browser uploads to directly. Nothing is
    /// written to S3 here — until the client completes the PUT the document simply does not
    /// exist, which is why an abandoned upload leaves no debris to clean up.
    /// </summary>
    public async Task<CreateDocumentResponse> CreateUploadTargetAsync(
        string ownerId,
        string filename,
        string? contentType,
        CancellationToken cancellationToken)
    {
        var id = DocumentKey.NewId();
        var key = DocumentKey.Build(options.Prefix, ownerId, id, filename);
        var resolvedContentType = NormalizeContentType(contentType);
        var expiresAt = DateTimeOffset.UtcNow.Add(options.UploadUrlLifetime);

        // Content-Type is part of the signature, so the client MUST send this exact value back.
        // The server picks it (rather than trusting whatever the browser guesses) precisely so
        // the two sides cannot disagree and produce an opaque 403 from S3.
        var url = await s3.GetPreSignedURLAsync(new GetPreSignedUrlRequest
        {
            BucketName = options.Bucket,
            Key = key,
            Verb = HttpVerb.PUT,
            Expires = expiresAt.UtcDateTime,
            ContentType = resolvedContentType,
        });

        cancellationToken.ThrowIfCancellationRequested();

        return new CreateDocumentResponse(
            id,
            filename,
            url,
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                [ContentTypeHeader] = resolvedContentType,
            },
            expiresAt);
    }

    /// <summary>
    /// Looks up one document, or null when the caller has no document with that id. Costs a
    /// narrow list (to recover the filename half of the key) plus a head (for the content type
    /// that only lives in object metadata).
    /// </summary>
    public async Task<DocumentDetail?> FindAsync(
        string ownerId,
        string documentId,
        CancellationToken cancellationToken) =>
        (await DescribeAsync(ownerId, documentId, cancellationToken))?.Detail;

    /// <summary>
    /// <see cref="FindAsync"/> plus the object's real key. Callers that go on to sign or
    /// mutate the object want the key S3 actually reported rather than one rebuilt from the
    /// filename: rebuilding round-trips through
    /// <see cref="Uri.UnescapeDataString"/>/<see cref="Uri.EscapeDataString"/>, which is exact
    /// for keys this API wrote but not for an oddly-escaped one placed by hand.
    /// </summary>
    private async Task<(string Key, DocumentDetail Detail)?> DescribeAsync(
        string ownerId,
        string documentId,
        CancellationToken cancellationToken)
    {
        var located = await LocateAsync(ownerId, documentId, cancellationToken);
        if (located is null)
        {
            return null;
        }

        var (key, filename, size, lastModified) = located.Value;

        GetObjectMetadataResponse metadata;
        try
        {
            metadata = await s3.GetObjectMetadataAsync(
                new GetObjectMetadataRequest { BucketName = options.Bucket, Key = key },
                cancellationToken);
        }
        catch (AmazonS3Exception ex) when (ex.StatusCode == HttpStatusCode.NotFound)
        {
            // Deleted between the list and the head — indistinguishable from never existing.
            return null;
        }

        return (key, new DocumentDetail(
            documentId,
            filename,
            size,
            lastModified,
            NormalizeContentType(metadata.Headers.ContentType),
            metadata.ETag));
    }

    /// <summary>
    /// Presigns a GET for one document. The response headers are overridden so the browser saves
    /// the file under its original name rather than the opaque key, using both the ASCII
    /// <c>filename</c> and the UTF-8 <c>filename*</c> form of RFC 6266.
    /// </summary>
    public async Task<DocumentContentResponse?> CreateDownloadUrlAsync(
        string ownerId,
        string documentId,
        CancellationToken cancellationToken)
    {
        var described = await DescribeAsync(ownerId, documentId, cancellationToken);
        if (described is null)
        {
            return null;
        }

        var (key, detail) = described.Value;
        var expiresAt = DateTimeOffset.UtcNow.Add(options.DownloadUrlLifetime);

        var url = await s3.GetPreSignedURLAsync(new GetPreSignedUrlRequest
        {
            BucketName = options.Bucket,
            Key = key,
            Verb = HttpVerb.GET,
            Expires = expiresAt.UtcDateTime,
            ResponseHeaderOverrides = new ResponseHeaderOverrides
            {
                ContentType = detail.ContentType,
                ContentDisposition = BuildContentDisposition(detail.Filename),
            },
        });

        return new DocumentContentResponse(documentId, detail.Filename, detail.ContentType, url, expiresAt);
    }

    /// <summary>
    /// Renames a document by copying the object to the new key and deleting the old one — the
    /// filename is part of the key, so there is no in-place edit. The id is preserved, so links
    /// and bookmarks survive. Copy-then-delete means a failure mid-way leaves the original
    /// intact rather than losing the document.
    /// </summary>
    public async Task<DocumentDetail?> RenameAsync(
        string ownerId,
        string documentId,
        string filename,
        CancellationToken cancellationToken)
    {
        var located = await LocateAsync(ownerId, documentId, cancellationToken);
        if (located is null)
        {
            return null;
        }

        var sourceKey = located.Value.Key;
        var destinationKey = DocumentKey.Build(options.Prefix, ownerId, documentId, filename);

        // Renaming to the current name must not fall through to copy-then-delete: the delete
        // would remove the object the copy just wrote to the same key.
        if (string.Equals(sourceKey, destinationKey, StringComparison.Ordinal))
        {
            return await FindAsync(ownerId, documentId, cancellationToken);
        }

        // MetadataDirective defaults to COPY, carrying the stored content type across.
        await s3.CopyObjectAsync(
            new CopyObjectRequest
            {
                SourceBucket = options.Bucket,
                SourceKey = sourceKey,
                DestinationBucket = options.Bucket,
                DestinationKey = destinationKey,
            },
            cancellationToken);

        await s3.DeleteObjectAsync(options.Bucket, sourceKey, cancellationToken);

        return await FindAsync(ownerId, documentId, cancellationToken);
    }

    /// <summary>
    /// Deletes a document. Returns false when the caller has no document with that id, so the
    /// endpoint can answer 404 rather than reporting success for something that never existed.
    /// </summary>
    public async Task<bool> DeleteAsync(string ownerId, string documentId, CancellationToken cancellationToken)
    {
        var located = await LocateAsync(ownerId, documentId, cancellationToken);
        if (located is null)
        {
            return false;
        }

        await s3.DeleteObjectAsync(options.Bucket, located.Value.Key, cancellationToken);
        return true;
    }

    /// <summary>
    /// Finds the single object making up a document by listing its own narrow prefix. This is
    /// how an id alone resolves to a key: the filename half is not knowable up front, and
    /// listing one prefix is cheaper and more truthful than guessing.
    /// </summary>
    private async Task<(string Key, string Filename, long Size, DateTimeOffset LastModified)?> LocateAsync(
        string ownerId,
        string documentId,
        CancellationToken cancellationToken)
    {
        var response = await s3.ListObjectsV2Async(
            new ListObjectsV2Request
            {
                BucketName = options.Bucket,
                Prefix = DocumentKey.DocumentPrefix(options.Prefix, ownerId, documentId),
                MaxKeys = 1,
            },
            cancellationToken);

        foreach (var item in response.S3Objects ?? [])
        {
            if (item.Key is not null
                && DocumentKey.TryParse(options.Prefix, ownerId, item.Key, out _, out var filename))
            {
                return (item.Key, filename, item.Size ?? 0, ToUtc(item.LastModified));
            }
        }

        return null;
    }

    private static string NormalizeContentType(string? contentType) =>
        string.IsNullOrWhiteSpace(contentType) ? DefaultContentType : contentType.Trim();

    /// <summary>
    /// Converts an S3 timestamp to a UTC-anchored <see cref="DateTimeOffset"/>.
    /// <para>
    /// S3 reports times in UTC, but the SDK surfaces them as a <see cref="DateTime"/> whose
    /// <see cref="DateTime.Kind"/> is not guaranteed — and the implicit conversion reads an
    /// <see cref="DateTimeKind.Unspecified"/> value as <em>local</em> time, which would silently
    /// shift every timestamp by the host's offset. That bug hides on a UTC server and appears
    /// only on a developer's machine, so the kind is pinned explicitly here.
    /// </para>
    /// </summary>
    private static DateTimeOffset ToUtc(DateTime? value)
    {
        if (value is not { } timestamp)
        {
            return default;
        }

        return timestamp.Kind switch
        {
            DateTimeKind.Utc => new DateTimeOffset(timestamp),
            DateTimeKind.Local => new DateTimeOffset(timestamp).ToUniversalTime(),
            _ => new DateTimeOffset(DateTime.SpecifyKind(timestamp, DateTimeKind.Utc)),
        };
    }

    /// <summary>
    /// RFC 6266 content disposition: a lossy ASCII <c>filename</c> for older clients plus the
    /// exact UTF-8 <c>filename*</c> that every current browser prefers.
    /// </summary>
    private static string BuildContentDisposition(string filename)
    {
        var ascii = string.Concat(filename.Select(static c =>
            char.IsAsciiLetterOrDigit(c) || c is '.' or '-' or '_' or ' ' ? c : '_'));

        return $"attachment; filename=\"{ascii}\"; filename*=UTF-8''{Uri.EscapeDataString(filename)}";
    }
}
