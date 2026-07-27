using System.Security.Claims;
using LoopedIn.Api.Infrastructure.Database;
using LoopedIn.Api.Infrastructure.Http;
using LoopedIn.Api.Models;

namespace LoopedIn.Api.Endpoints;

/// <summary>
/// CRUD over the shared client list and its contacts.
/// </summary>
/// <remarks>
/// <para>
/// <b>These rows are shared by every signed-in user</b>, which is the deliberate divergence from
/// documents: a document's S3 key derives from the caller's own <c>sub</c>, so no request shape
/// reaches another user's data, whereas here everyone reads and writes everything. That is right
/// for one team's outreach list, but it means <c>RequireAuthorization()</c> is the only line of
/// defence — and it is only as narrow as who can sign up for the Clerk instance. Restricting
/// sign-up is a precondition for seeding real data here, not optional hardening.
/// </para>
/// <para>
/// <c>created_by</c> and <c>updated_by</c> come from the validated token's subject and never from
/// the request body, so "who did this" cannot be spoofed even though "what they may touch" is
/// unrestricted.
/// </para>
/// </remarks>
public static class ClientEndpoints
{
    /// <summary>
    /// Maps the client routes as one group.
    /// </summary>
    /// <remarks>
    /// Authorization and the database gate are stated once, on the group, so a route added later
    /// cannot forget either. There is deliberately no <c>/clients/ping</c>: <c>/db/ping</c>
    /// already probes this exact dependency — including migration state — and a second public
    /// probe is another anonymous path to real database work.
    /// </remarks>
    public static IEndpointRouteBuilder MapClientEndpoints(this IEndpointRouteBuilder app)
    {
        var clients = app.MapGroup("/clients")
            .RequireAuthorization()
            .AddEndpointFilter<DatabaseGateFilter>();

        clients.MapGet("/", ListAsync).WithName("ListClients");
        clients.MapPost("/", CreateAsync).WithName("CreateClient");
        clients.MapGet("/{id:guid}", GetAsync).WithName("GetClient");
        clients.MapPatch("/{id:guid}", UpdateAsync).WithName("UpdateClient");
        clients.MapDelete("/{id:guid}", DeleteAsync).WithName("DeleteClient");

        clients.MapPost("/{id:guid}/status", ChangeStatusAsync).WithName("ChangeClientStatus");
        clients.MapGet("/{id:guid}/status-history", ListStatusHistoryAsync).WithName("ListClientStatusHistory");

        clients.MapPost("/{id:guid}/contacts", AddContactAsync).WithName("AddClientContact");
        clients.MapPatch("/{id:guid}/contacts/{contactId:guid}", UpdateContactAsync).WithName("UpdateClientContact");
        clients.MapDelete("/{id:guid}/contacts/{contactId:guid}", DeleteContactAsync).WithName("DeleteClientContact");

        clients.MapGet("/{id:guid}/interactions", ListInteractionsAsync).WithName("ListClientInteractions");
        clients.MapPost("/{id:guid}/interactions", AddInteractionAsync).WithName("AddClientInteraction");
        clients.MapPatch("/{id:guid}/interactions/{interactionId:guid}", UpdateInteractionAsync)
            .WithName("UpdateClientInteraction");
        clients.MapDelete("/{id:guid}/interactions/{interactionId:guid}", DeleteInteractionAsync)
            .WithName("DeleteClientInteraction");

        return app;
    }

    /// <summary>
    /// A page of clients, filtered by <c>?search=</c>, <c>?industry=</c> and <c>?status=</c>.
    /// </summary>
    private static async Task<IResult> ListAsync(
        IServiceProvider services,
        string? search,
        string? industry,
        string? status,
        int? limit,
        int? offset,
        CancellationToken cancellationToken) =>
        Results.Ok(await Store(services).ListAsync(
            ClientValidation.SearchPattern(search),
            ClientValidation.Clean(industry),
            ClientValidation.Clean(status),
            ClientValidation.PageSize(limit),
            ClientValidation.PageOffset(offset),
            cancellationToken));

    private static async Task<IResult> CreateAsync(
        IServiceProvider services,
        ClaimsPrincipal user,
        CreateClientRequest? request,
        CancellationToken cancellationToken)
    {
        if (!ClientValidation.TryReadClient(request, out var fields, out var error))
        {
            return BadRequest(error);
        }

        var created = await Store(services).CreateAsync(fields, user.RequireSubject(), cancellationToken);
        return Results.Created($"/clients/{created.Client.Id}", created);
    }

    private static async Task<IResult> GetAsync(
        IServiceProvider services,
        Guid id,
        CancellationToken cancellationToken) =>
        await Store(services).FindAsync(id, cancellationToken) is { } client
            ? Results.Ok(client)
            : ClientNotFound();

    private static async Task<IResult> UpdateAsync(
        IServiceProvider services,
        ClaimsPrincipal user,
        Guid id,
        UpdateClientRequest? request,
        CancellationToken cancellationToken)
    {
        if (request?.ExpectedVersion is not { } expectedVersion)
        {
            return MissingVersion("client");
        }

        if (!ClientValidation.TryReadClient(request, out var fields, out var error))
        {
            return BadRequest(error);
        }

        var result = await Store(services).UpdateAsync(
            id, fields, expectedVersion, user.RequireSubject(), cancellationToken);

        return result.Status switch
        {
            MutationStatus.Applied => Results.Ok(result.Value),
            MutationStatus.VersionConflict => Stale("client"),
            _ => ClientNotFound(),
        };
    }

    private static async Task<IResult> DeleteAsync(
        IServiceProvider services,
        Guid id,
        CancellationToken cancellationToken) =>
        await Store(services).DeleteAsync(id, cancellationToken) ? Results.NoContent() : ClientNotFound();

    /// <summary>
    /// The one route that moves a client's status. A transition is an event, not a field edit:
    /// it appends to the history and may stamp <c>acquired_at</c>, which is why it does not ride
    /// on the full-replacement PATCH.
    /// </summary>
    private static async Task<IResult> ChangeStatusAsync(
        IServiceProvider services,
        ClaimsPrincipal user,
        Guid id,
        ChangeClientStatusRequest? request,
        CancellationToken cancellationToken)
    {
        if (request?.ExpectedVersion is not { } expectedVersion)
        {
            return MissingVersion("client");
        }

        if (!ClientValidation.TryReadStatusChange(request, out var change, out var error))
        {
            return BadRequest(error);
        }

        var result = await Store(services).ChangeStatusAsync(
            id, change, expectedVersion, user.RequireSubject(), cancellationToken);

        return result.Status switch
        {
            MutationStatus.Applied => Results.Ok(result.Value),
            MutationStatus.VersionConflict => Stale("client"),
            _ => ClientNotFound(),
        };
    }

    private static async Task<IResult> ListStatusHistoryAsync(
        IServiceProvider services,
        Guid id,
        CancellationToken cancellationToken) =>
        await Store(services).ListStatusHistoryAsync(id, cancellationToken) is { } history
            ? Results.Ok(history)
            : ClientNotFound();

    private static async Task<IResult> AddContactAsync(
        IServiceProvider services,
        ClaimsPrincipal user,
        Guid id,
        CreateContactRequest? request,
        CancellationToken cancellationToken)
    {
        if (!ClientValidation.TryReadContact(request, out var fields, out var error))
        {
            return BadRequest(error);
        }

        var result = await Store(services).AddContactAsync(
            id, fields, user.RequireSubject(), cancellationToken);

        return result.Status switch
        {
            MutationStatus.Applied => Results.Created($"/clients/{id}", result.Value),
            MutationStatus.Duplicate => Duplicate(result.Message),
            _ => ClientNotFound(),
        };
    }

    private static async Task<IResult> UpdateContactAsync(
        IServiceProvider services,
        ClaimsPrincipal user,
        Guid id,
        Guid contactId,
        UpdateContactRequest? request,
        CancellationToken cancellationToken)
    {
        if (request?.ExpectedVersion is not { } expectedVersion)
        {
            return MissingVersion("contact");
        }

        if (!ClientValidation.TryReadContact(request, out var fields, out var error))
        {
            return BadRequest(error);
        }

        var result = await Store(services).UpdateContactAsync(
            id, contactId, fields, expectedVersion, user.RequireSubject(), cancellationToken);

        return result.Status switch
        {
            MutationStatus.Applied => Results.Ok(result.Value),
            MutationStatus.VersionConflict => Stale("contact"),
            MutationStatus.Duplicate => Duplicate(result.Message),
            _ => ContactNotFound(),
        };
    }

    private static async Task<IResult> DeleteContactAsync(
        IServiceProvider services,
        Guid id,
        Guid contactId,
        CancellationToken cancellationToken) =>
        await Store(services).DeleteContactAsync(id, contactId, cancellationToken)
            ? Results.NoContent()
            : ContactNotFound();

    private static async Task<IResult> ListInteractionsAsync(
        IServiceProvider services,
        Guid id,
        CancellationToken cancellationToken) =>
        await Store(services).ListInteractionsAsync(id, cancellationToken) is { } interactions
            ? Results.Ok(interactions)
            : ClientNotFound();

    private static async Task<IResult> AddInteractionAsync(
        IServiceProvider services,
        ClaimsPrincipal user,
        Guid id,
        CreateInteractionRequest? request,
        CancellationToken cancellationToken)
    {
        if (!ClientValidation.TryReadInteraction(request, out var fields, out var error))
        {
            return BadRequest(error);
        }

        var result = await Store(services).AddInteractionAsync(
            id, fields, user.RequireSubject(), cancellationToken);

        return result.Status switch
        {
            MutationStatus.Applied => Results.Created($"/clients/{id}", result.Value),
            MutationStatus.InvalidReference => BadRequest(result.Message!),
            _ => ClientNotFound(),
        };
    }

    private static async Task<IResult> UpdateInteractionAsync(
        IServiceProvider services,
        ClaimsPrincipal user,
        Guid id,
        Guid interactionId,
        UpdateInteractionRequest? request,
        CancellationToken cancellationToken)
    {
        if (request?.ExpectedVersion is not { } expectedVersion)
        {
            return MissingVersion("interaction");
        }

        if (!ClientValidation.TryReadInteraction(request, out var fields, out var error))
        {
            return BadRequest(error);
        }

        var result = await Store(services).UpdateInteractionAsync(
            id, interactionId, fields, expectedVersion, user.RequireSubject(), cancellationToken);

        return result.Status switch
        {
            MutationStatus.Applied => Results.Ok(result.Value),
            MutationStatus.VersionConflict => Stale("interaction"),
            MutationStatus.InvalidReference => BadRequest(result.Message!),
            _ => InteractionNotFound(),
        };
    }

    private static async Task<IResult> DeleteInteractionAsync(
        IServiceProvider services,
        Guid id,
        Guid interactionId,
        CancellationToken cancellationToken) =>
        await Store(services).DeleteInteractionAsync(id, interactionId, cancellationToken)
            ? Results.NoContent()
            : InteractionNotFound();

    /// <summary>
    /// Resolved per request rather than taken as a handler parameter, because the store is only
    /// registered when <c>DATABASE_URL</c> is set — and minimal-API parameter binding happens
    /// <em>before</em> endpoint filters run, so an unregistered service would blow up in front of
    /// the 503 <see cref="DatabaseGateFilter"/> exists to give. By the time a handler body runs,
    /// the filter has already established that the database is usable.
    /// </summary>
    private static ClientStore Store(IServiceProvider services) => services.GetRequiredService<ClientStore>();

    private static IResult BadRequest(string message) =>
        Results.Problem(message, statusCode: StatusCodes.Status400BadRequest);

    private static IResult ClientNotFound() =>
        Results.Problem("Client not found.", statusCode: StatusCodes.Status404NotFound);

    private static IResult ContactNotFound() =>
        Results.Problem("Contact not found.", statusCode: StatusCodes.Status404NotFound);

    private static IResult InteractionNotFound() =>
        Results.Problem("Interaction not found.", statusCode: StatusCodes.Status404NotFound);

    private static IResult Duplicate(string? message) =>
        Results.Problem(
            message ?? "That contact already exists.", statusCode: StatusCodes.Status409Conflict);

    private static IResult Stale(string noun) =>
        Results.Problem(
            $"This {noun} was changed by someone else — reload and try again.",
            statusCode: StatusCodes.Status409Conflict);

    /// <summary>
    /// A PATCH without <c>expectedVersion</c> is refused rather than applied blind. Making the
    /// token optional would make the protection decorative the day the UI forgets to send it —
    /// and on a list several people edit at once, that is the day someone's work disappears.
    /// </summary>
    private static IResult MissingVersion(string noun) =>
        BadRequest(
            $"expectedVersion is required. Send the version you loaded with the {noun} so a "
                + "simultaneous edit by someone else is detected instead of overwritten.");
}
