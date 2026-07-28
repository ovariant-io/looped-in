namespace LoopedIn.Api.Models;

// Request and response shapes for /campaigns. The two conventions stated at the top of
// Client.cs — `Version` is the concurrency token and PATCH is a full replacement where null
// means CLEAR THE FIELD — hold here unchanged.

/// <summary>
/// A campaign as it appears in a listing. The per-state counts are derived from
/// <c>campaign_messages</c> — a campaign has no status column of its own, so these counts ARE
/// its progress. They mirror the <c>campaign_messages_state_allowed</c> vocabulary; extending
/// that list means extending this record and the query behind it.
/// </summary>
public sealed record CampaignSummary(
    Guid Id,
    string Name,
    int MessageCount,
    int DraftedCount,
    int ApprovedCount,
    int SentCount,
    int SkippedCount,
    long Version,
    DateTimeOffset UpdatedAt);

/// <summary>
/// One drafted email, joined with the display names its ids point at. One shape for reads and
/// write returns. <paramref name="State"/> and <paramref name="SentAt"/> move only through
/// <c>POST /campaigns/{id}/messages/{messageId}/state</c> — PATCH replaces the draft fields and
/// deliberately cannot touch either.
/// </summary>
/// <param name="ClientName">Joined from <c>clients</c> for display; the id is the reference.</param>
/// <param name="ContactName">Joined from <c>contacts</c>; null when no recipient is set.</param>
public sealed record CampaignMessage(
    Guid Id,
    Guid ClientId,
    string ClientName,
    Guid? ContactId,
    string? ContactName,
    string Subject,
    string Body,
    string State,
    DateTimeOffset? SentAt,
    long Version,
    DateTimeOffset CreatedAt,
    string CreatedBy,
    DateTimeOffset UpdatedAt,
    string UpdatedBy);

/// <summary>
/// A recipient choice for one of the campaign's messages: a contact of a client that already
/// has a message in the campaign.
/// </summary>
/// <remarks>
/// These ride on <see cref="CampaignDetail"/> rather than on each message because the recipient
/// picker is a detail-page concern: client list summaries carry a contact count, not contacts,
/// so the detail read is the one place the options can come from without a per-message fetch.
/// The unique (campaign, client) constraint means no client's contacts appear twice.
/// </remarks>
public sealed record CampaignContactOption(
    Guid ClientId,
    Guid Id,
    string? FullName,
    string? Email);

/// <summary>One campaign with its messages, read whole like a client's contacts.</summary>
public sealed record CampaignDetail(
    Guid Id,
    string Name,
    string? Brief,
    IReadOnlyList<CampaignMessage> Messages,
    IReadOnlyList<CampaignContactOption> ContactOptions,
    long Version,
    DateTimeOffset CreatedAt,
    string CreatedBy,
    DateTimeOffset UpdatedAt,
    string UpdatedBy);

/// <summary>A page of campaigns. <paramref name="Total"/> counts matches before paging.</summary>
public sealed record CampaignListResponse(
    IReadOnlyList<CampaignSummary> Campaigns,
    int Total,
    int Limit,
    int Offset);

/// <summary>
/// Body of <c>POST /campaigns</c>. Unlike clients there is no duplicate-name warning on create:
/// campaigns are named by the same team that reads the list, and nothing imports them.
/// </summary>
public sealed record CreateCampaignRequest(string? Name, string? Brief);

/// <summary>Body of <c>PATCH /campaigns/{id}</c>. <paramref name="ExpectedVersion"/> is required.</summary>
public sealed record UpdateCampaignRequest(string? Name, string? Brief, long? ExpectedVersion);

/// <summary>Body of <c>POST /campaigns/{id}/messages</c>. The message starts as <c>drafted</c>.</summary>
public sealed record CreateCampaignMessageRequest(
    Guid? ClientId,
    Guid? ContactId,
    string? Subject,
    string? Body);

/// <summary>
/// Body of <c>PATCH /campaigns/{id}/messages/{messageId}</c>. Carries the draft fields but
/// never <c>state</c> — see <see cref="ChangeCampaignMessageStateRequest"/>.
/// </summary>
public sealed record UpdateCampaignMessageRequest(
    string? Subject,
    string? Body,
    Guid? ContactId,
    long? ExpectedVersion);

/// <summary>
/// Body of <c>POST /campaigns/{id}/messages/{messageId}/state</c> — the only way a message's
/// state moves. A dedicated endpoint because entering <c>sent</c> is an event: it stamps
/// <c>sent_at</c> and appends an <c>email</c> interaction to the client's outreach log.
/// </summary>
public sealed record ChangeCampaignMessageStateRequest(string? State, long? ExpectedVersion);
