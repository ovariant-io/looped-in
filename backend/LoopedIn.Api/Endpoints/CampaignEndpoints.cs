using System.Security.Claims;
using LoopedIn.Api.Infrastructure.Database;
using LoopedIn.Api.Infrastructure.Http;
using LoopedIn.Api.Models;

namespace LoopedIn.Api.Endpoints;

/// <summary>
/// CRUD over EDM campaigns and their per-client message drafts.
/// </summary>
/// <remarks>
/// <para>
/// These rows carry the same trust model as <c>/clients</c> — shared by every signed-in user,
/// with <c>RequireAuthorization()</c> as the only line of defence — and campaign copy raises
/// the stakes on it. See the remarks on <see cref="ClientEndpoints"/>.
/// </para>
/// <para>
/// A message's state moves only through the <c>/state</c> route, never through PATCH, because
/// entering <c>sent</c> is an event with side effects: it stamps <c>sent_at</c> and appends an
/// <c>email</c> interaction to the client's outreach log. Sending itself is a human act —
/// nothing here transmits an email.
/// </para>
/// </remarks>
public static class CampaignEndpoints
{
    /// <summary>
    /// Maps the campaign routes as one group. Authorization and the database gate are stated
    /// once, on the group, like <see cref="ClientEndpoints"/>; <c>/db/ping</c> already probes
    /// the dependency, so there is no <c>/campaigns/ping</c>.
    /// </summary>
    public static IEndpointRouteBuilder MapCampaignEndpoints(this IEndpointRouteBuilder app)
    {
        var campaigns = app.MapGroup("/campaigns")
            .RequireAuthorization()
            .AddEndpointFilter<DatabaseGateFilter>();

        campaigns.MapGet("/", ListAsync).WithName("ListCampaigns");
        campaigns.MapPost("/", CreateAsync).WithName("CreateCampaign");
        campaigns.MapGet("/{id:guid}", GetAsync).WithName("GetCampaign");
        campaigns.MapPatch("/{id:guid}", UpdateAsync).WithName("UpdateCampaign");
        campaigns.MapDelete("/{id:guid}", DeleteAsync).WithName("DeleteCampaign");

        campaigns.MapPost("/{id:guid}/messages", AddMessageAsync).WithName("AddCampaignMessage");
        campaigns.MapPatch("/{id:guid}/messages/{messageId:guid}", UpdateMessageAsync)
            .WithName("UpdateCampaignMessage");
        campaigns.MapDelete("/{id:guid}/messages/{messageId:guid}", DeleteMessageAsync)
            .WithName("DeleteCampaignMessage");

        campaigns.MapPost("/{id:guid}/messages/{messageId:guid}/state", ChangeMessageStateAsync)
            .WithName("ChangeCampaignMessageState");

        return app;
    }

    /// <summary>A page of campaigns, filtered by <c>?search=</c> over the name.</summary>
    private static async Task<IResult> ListAsync(
        IServiceProvider services,
        string? search,
        int? limit,
        int? offset,
        CancellationToken cancellationToken) =>
        Results.Ok(await Store(services).ListAsync(
            ClientValidation.SearchPattern(search),
            ClientValidation.PageSize(limit),
            ClientValidation.PageOffset(offset),
            cancellationToken));

    private static async Task<IResult> CreateAsync(
        IServiceProvider services,
        ClaimsPrincipal user,
        CreateCampaignRequest? request,
        CancellationToken cancellationToken)
    {
        if (!CampaignValidation.TryReadCampaign(request, out var fields, out var error))
        {
            return BadRequest(error);
        }

        var campaign = await Store(services).CreateAsync(fields, user.RequireSubject(), cancellationToken);
        return Results.Created($"/campaigns/{campaign.Id}", campaign);
    }

    private static async Task<IResult> GetAsync(
        IServiceProvider services,
        Guid id,
        CancellationToken cancellationToken) =>
        await Store(services).FindAsync(id, cancellationToken) is { } campaign
            ? Results.Ok(campaign)
            : CampaignNotFound();

    private static async Task<IResult> UpdateAsync(
        IServiceProvider services,
        ClaimsPrincipal user,
        Guid id,
        UpdateCampaignRequest? request,
        CancellationToken cancellationToken)
    {
        if (request?.ExpectedVersion is not { } expectedVersion)
        {
            return MissingVersion("campaign");
        }

        if (!CampaignValidation.TryReadCampaign(request, out var fields, out var error))
        {
            return BadRequest(error);
        }

        var result = await Store(services).UpdateAsync(
            id, fields, expectedVersion, user.RequireSubject(), cancellationToken);

        return result.Status switch
        {
            MutationStatus.Applied => Results.Ok(result.Value),
            MutationStatus.VersionConflict => Stale("campaign"),
            _ => CampaignNotFound(),
        };
    }

    private static async Task<IResult> DeleteAsync(
        IServiceProvider services,
        Guid id,
        CancellationToken cancellationToken) =>
        await Store(services).DeleteAsync(id, cancellationToken) ? Results.NoContent() : CampaignNotFound();

    private static async Task<IResult> AddMessageAsync(
        IServiceProvider services,
        ClaimsPrincipal user,
        Guid id,
        CreateCampaignMessageRequest? request,
        CancellationToken cancellationToken)
    {
        // Checked here like ExpectedVersion is, rather than in TryReadMessage: the update body
        // shares that validator and carries no client — a message never changes client.
        if (request?.ClientId is not { } clientId)
        {
            return BadRequest("A message needs a clientId.");
        }

        if (!CampaignValidation.TryReadMessage(request, out var fields, out var error))
        {
            return BadRequest(error);
        }

        var result = await Store(services).AddMessageAsync(
            id, clientId, fields, user.RequireSubject(), cancellationToken);

        return result.Status switch
        {
            // Location names the campaign, not the message: a message has no GET route of its
            // own — the campaign detail is the nearest URL at which the new draft is readable.
            MutationStatus.Applied => Results.Created($"/campaigns/{id}", result.Value),
            MutationStatus.InvalidReference => BadRequest(result.Message!),
            _ => CampaignNotFound(),
        };
    }

    private static async Task<IResult> UpdateMessageAsync(
        IServiceProvider services,
        ClaimsPrincipal user,
        Guid id,
        Guid messageId,
        UpdateCampaignMessageRequest? request,
        CancellationToken cancellationToken)
    {
        if (request?.ExpectedVersion is not { } expectedVersion)
        {
            return MissingVersion("message");
        }

        if (!CampaignValidation.TryReadMessage(request, out var fields, out var error))
        {
            return BadRequest(error);
        }

        var result = await Store(services).UpdateMessageAsync(
            id, messageId, fields, expectedVersion, user.RequireSubject(), cancellationToken);

        return result.Status switch
        {
            MutationStatus.Applied => Results.Ok(result.Value),
            MutationStatus.VersionConflict => Stale("message"),
            MutationStatus.InvalidReference => BadRequest(result.Message!),
            _ => MessageNotFound(),
        };
    }

    private static async Task<IResult> DeleteMessageAsync(
        IServiceProvider services,
        Guid id,
        Guid messageId,
        CancellationToken cancellationToken) =>
        await Store(services).DeleteMessageAsync(id, messageId, cancellationToken)
            ? Results.NoContent()
            : MessageNotFound();

    /// <summary>
    /// The one route that moves a message's state. A transition is an event, not a field edit —
    /// entering <c>sent</c> stamps <c>sent_at</c> and logs the send as an interaction, which is
    /// why it does not ride on the full-replacement PATCH.
    /// </summary>
    private static async Task<IResult> ChangeMessageStateAsync(
        IServiceProvider services,
        ClaimsPrincipal user,
        Guid id,
        Guid messageId,
        ChangeCampaignMessageStateRequest? request,
        CancellationToken cancellationToken)
    {
        if (request?.ExpectedVersion is not { } expectedVersion)
        {
            return MissingVersion("message");
        }

        if (!CampaignValidation.TryReadMessageState(request, out var state, out var error))
        {
            return BadRequest(error);
        }

        var result = await Store(services).ChangeMessageStateAsync(
            id, messageId, state, expectedVersion, user.RequireSubject(), cancellationToken);

        return result.Status switch
        {
            MutationStatus.Applied => Results.Ok(result.Value),
            MutationStatus.VersionConflict => Stale("message"),
            _ => MessageNotFound(),
        };
    }

    /// <summary>
    /// Resolved per request rather than taken as a handler parameter, for the reason
    /// <see cref="ClientEndpoints"/> records: parameter binding runs before the filter that
    /// answers 503 when the store is unregistered.
    /// </summary>
    private static CampaignStore Store(IServiceProvider services) =>
        services.GetRequiredService<CampaignStore>();

    private static IResult BadRequest(string message) =>
        Results.Problem(message, statusCode: StatusCodes.Status400BadRequest);

    private static IResult CampaignNotFound() =>
        Results.Problem("Campaign not found.", statusCode: StatusCodes.Status404NotFound);

    private static IResult MessageNotFound() =>
        Results.Problem("Message not found.", statusCode: StatusCodes.Status404NotFound);

    private static IResult Stale(string noun) =>
        Results.Problem(
            $"This {noun} was changed by someone else — reload and try again.",
            statusCode: StatusCodes.Status409Conflict);

    private static IResult MissingVersion(string noun) =>
        BadRequest(
            $"expectedVersion is required. Send the version you loaded with the {noun} so a "
                + "simultaneous edit by someone else is detected instead of overwritten.");
}
