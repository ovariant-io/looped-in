using System.Security.Claims;
using Amazon.Runtime;
using LoopedIn.Api.Infrastructure.Diagnostics;
using LoopedIn.Api.Infrastructure.Http;
using LoopedIn.Api.Infrastructure.Storage;
using LoopedIn.Api.Models;

namespace LoopedIn.Api.Endpoints;

/// <summary>
/// Document CRUD over S3. Bytes never traverse this API: creating a document hands back a
/// presigned PUT the browser uploads to directly, and reading one hands back a presigned GET.
/// That keeps arbitrarily large files clear of the 10 MB API Gateway request cap and the Lambda
/// payload limit, and means these handlers only ever move metadata.
/// <para>
/// Every protected handler derives its S3 prefix from the <c>sub</c> claim of the validated
/// Clerk token. A client supplies a document <em>id</em>, never a key, so there is no request
/// shape that reaches another user's objects — an id belonging to someone else simply resolves
/// to nothing under the caller's own prefix and answers 404.
/// </para>
/// </summary>
public static class DocumentEndpoints
{
    /// <summary>
    /// Maps the document routes. <c>/documents/ping</c> is public (it mirrors <c>/db/ping</c> and
    /// <c>/auth/ping</c> as a configuration check); everything else requires a valid token.
    /// </summary>
    /// <remarks>
    /// <c>/documents/ping</c> and <c>/documents/{id}</c> are not ambiguous: ASP.NET Core's route
    /// matching ranks a literal segment above a parameter, so <c>ping</c> can never be read as an
    /// id — and it could not be one anyway, since ids must parse as 32-hex-digit GUIDs.
    /// </remarks>
    public static IEndpointRouteBuilder MapDocumentEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/documents/ping", PingAsync)
            .WithName("DocumentsPing");

        app.MapGet("/documents", ListAsync)
            .RequireAuthorization()
            .WithName("ListDocuments");

        app.MapPost("/documents", CreateAsync)
            .RequireAuthorization()
            .WithName("CreateDocument");

        app.MapPost("/documents/{id}/complete", CompleteAsync)
            .RequireAuthorization()
            .WithName("CompleteDocumentUpload");

        app.MapGet("/documents/{id}", GetAsync)
            .RequireAuthorization()
            .WithName("GetDocument");

        app.MapGet("/documents/{id}/content", GetContentAsync)
            .RequireAuthorization()
            .WithName("GetDocumentContent");

        app.MapPatch("/documents/{id}", RenameAsync)
            .RequireAuthorization()
            .WithName("RenameDocument");

        app.MapDelete("/documents/{id}", DeleteAsync)
            .RequireAuthorization()
            .WithName("DeleteDocument");

        return app;
    }

    /// <summary>
    /// Public connectivity check, mirroring <c>/db/ping</c> and <c>/auth/ping</c>: reports 503
    /// with the reason when storage is unconfigured or the bucket cannot be listed, so a
    /// misconfigured deployment is diagnosable without a valid session.
    /// </summary>
    /// <remarks>
    /// The result is cached for a few seconds (<see cref="ProbeCache"/>): this endpoint issues a
    /// real <c>ListObjectsV2</c>, and being public it would otherwise let an anonymous caller
    /// drive billable S3 traffic at whatever rate the gateway throttle permits.
    /// </remarks>
    private static Task<IResult> PingAsync(IServiceProvider services, ProbeCache probes) =>
        probes.GetOrProbeAsync("documents", async () =>
        {
            var status = services.GetRequiredService<DocumentStorageStatus>();
            if (!status.Configured)
            {
                return Results.Problem(
                    status.Reason ?? "Document storage is not configured.",
                    statusCode: StatusCodes.Status503ServiceUnavailable);
            }

            try
            {
                // Not the request's token: this probe is shared by every caller inside the TTL,
                // so one disconnecting client must not cancel it for the others.
                await services.GetRequiredService<DocumentStore>().CheckAsync(CancellationToken.None);
                return Results.Ok(new
                {
                    configured = true,
                    bucket = status.Bucket,
                    prefix = status.Prefix,
                });
            }
            catch (Exception ex)
            {
                return Results.Problem(ex.Message, statusCode: StatusCodes.Status503ServiceUnavailable);
            }
        });

    private static Task<IResult> ListAsync(
        IServiceProvider services,
        ClaimsPrincipal user,
        CancellationToken cancellationToken) =>
        WithStoreAsync(services, user, async (store, ownerId) =>
            Results.Ok(await store.ListAsync(ownerId, cancellationToken)));

    /// <summary>
    /// Reserves an id and returns a presigned PUT. Nothing exists in S3 until the client
    /// completes that PUT, so an abandoned upload leaves nothing behind to reap.
    /// </summary>
    private static Task<IResult> CreateAsync(
        IServiceProvider services,
        ClaimsPrincipal user,
        CreateDocumentRequest? request,
        CancellationToken cancellationToken) =>
        WithStoreAsync(services, user, async (store, ownerId) =>
        {
            if (!DocumentKey.TryNormalizeFilename(request?.Filename, out var filename, out var error))
            {
                return Results.Problem(error, statusCode: StatusCodes.Status400BadRequest);
            }

            // The declared size is required so an oversized upload is refused before anything
            // is signed. Note what this is and isn't: it stops an honest client from starting
            // a doomed transfer and gives the UI a limit to state, but S3 cannot enforce a
            // length on a query-signed PUT, so a hostile client can still understate its size.
            // DocumentStorageOptions.MaxUploadBytes documents the trade and the real fix.
            if (request?.Size is not { } size || size < 0)
            {
                return Results.Problem(
                    "A non-negative size (in bytes) is required so the upload can be checked against the limit.",
                    statusCode: StatusCodes.Status400BadRequest);
            }

            if (size > store.MaxUploadBytes)
            {
                return Results.Problem(
                    $"That file is {size:N0} bytes, over the {store.MaxUploadBytes:N0}-byte upload limit.",
                    statusCode: StatusCodes.Status413PayloadTooLarge);
            }

            var target = await store.CreateUploadTargetAsync(
                ownerId, filename, request.ContentType, cancellationToken);

            return Results.Ok(target);
        });

    /// <summary>
    /// Confirms the upload landed and returns the stored document. Optional in the sense that the
    /// object exists the moment S3 accepts the PUT — but it is how a client learns the real size
    /// and content type S3 recorded, and how it distinguishes a completed upload from a failed one.
    /// </summary>
    private static Task<IResult> CompleteAsync(
        IServiceProvider services,
        ClaimsPrincipal user,
        string id,
        CancellationToken cancellationToken) =>
        WithDocumentAsync(services, user, id, async (store, ownerId, documentId) =>
        {
            var detail = await store.FindAsync(ownerId, documentId, cancellationToken);
            return detail is null
                ? Results.Problem(
                    "No uploaded object was found for this document. The PUT to the presigned URL "
                        + "may not have completed, or the URL may have expired.",
                    statusCode: StatusCodes.Status404NotFound)
                : Results.Ok(detail);
        });

    private static Task<IResult> GetAsync(
        IServiceProvider services,
        ClaimsPrincipal user,
        string id,
        CancellationToken cancellationToken) =>
        WithDocumentAsync(services, user, id, async (store, ownerId, documentId) =>
        {
            var detail = await store.FindAsync(ownerId, documentId, cancellationToken);
            return detail is null ? NotFound() : Results.Ok(detail);
        });

    private static Task<IResult> GetContentAsync(
        IServiceProvider services,
        ClaimsPrincipal user,
        string id,
        CancellationToken cancellationToken) =>
        WithDocumentAsync(services, user, id, async (store, ownerId, documentId) =>
        {
            var content = await store.CreateDownloadUrlAsync(ownerId, documentId, cancellationToken);
            return content is null ? NotFound() : Results.Ok(content);
        });

    private static Task<IResult> RenameAsync(
        IServiceProvider services,
        ClaimsPrincipal user,
        string id,
        RenameDocumentRequest? request,
        CancellationToken cancellationToken) =>
        WithDocumentAsync(services, user, id, async (store, ownerId, documentId) =>
        {
            if (!DocumentKey.TryNormalizeFilename(request?.Filename, out var filename, out var error))
            {
                return Results.Problem(error, statusCode: StatusCodes.Status400BadRequest);
            }

            var detail = await store.RenameAsync(ownerId, documentId, filename, cancellationToken);
            return detail is null ? NotFound() : Results.Ok(detail);
        });

    private static Task<IResult> DeleteAsync(
        IServiceProvider services,
        ClaimsPrincipal user,
        string id,
        CancellationToken cancellationToken) =>
        WithDocumentAsync(services, user, id, async (store, ownerId, documentId) =>
            await store.DeleteAsync(ownerId, documentId, cancellationToken)
                ? Results.NoContent()
                : NotFound());

    /// <summary>
    /// The shared preamble for every protected handler: resolve the store (503 when storage is
    /// unconfigured), resolve and validate the caller's Clerk subject, and translate AWS failures
    /// into a 503 rather than letting them surface as a 500.
    /// </summary>
    private static async Task<IResult> WithStoreAsync(
        IServiceProvider services,
        ClaimsPrincipal user,
        Func<DocumentStore, string, Task<IResult>> handler)
    {
        var store = services.GetService<DocumentStore>();
        if (store is null)
        {
            var status = services.GetRequiredService<DocumentStorageStatus>();
            return Results.Problem(
                status.Reason ?? "Document storage is not configured.",
                statusCode: StatusCodes.Status503ServiceUnavailable);
        }

        var ownerId = user.GetSubject();
        if (!DocumentKey.IsValidOwnerId(ownerId))
        {
            // The token validated but carries no usable subject — refuse rather than invent a
            // prefix, because a wrong prefix is a tenancy bug, not a bad request.
            return Results.Problem(
                "The authenticated token carries no usable subject claim.",
                statusCode: StatusCodes.Status401Unauthorized);
        }

        try
        {
            return await handler(store, ownerId!);
        }
        catch (AmazonClientException ex)
        {
            // The base of the AWS exception tree: AmazonS3Exception derives from
            // AmazonServiceException, which derives from this. So one catch covers S3 service
            // errors as well as the credential/region resolution failures that only surface on
            // the first real call. From the caller's side, storage is simply unavailable.
            return Results.Problem(
                $"Document storage is unavailable: {ex.Message}",
                statusCode: StatusCodes.Status503ServiceUnavailable);
        }
    }

    /// <summary>
    /// <see cref="WithStoreAsync"/> plus document-id validation. An id that is not a 32-hex-digit
    /// GUID is rejected as 404 rather than 400: it cannot name anything, and answering 404
    /// keeps probing for other users' ids uninformative.
    /// </summary>
    private static Task<IResult> WithDocumentAsync(
        IServiceProvider services,
        ClaimsPrincipal user,
        string id,
        Func<DocumentStore, string, string, Task<IResult>> handler) =>
        WithStoreAsync(services, user, (store, ownerId) =>
            DocumentKey.TryNormalizeId(id, out var documentId)
                ? handler(store, ownerId, documentId)
                : Task.FromResult(NotFound()));

    private static IResult NotFound() =>
        Results.Problem("Document not found.", statusCode: StatusCodes.Status404NotFound);
}
