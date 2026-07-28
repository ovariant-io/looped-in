namespace LoopedIn.Api.Models;

// Request and response shapes for /clients.
//
// Two conventions run through this file and are meant to outlive it:
//
//   * `Version` is the optimistic-concurrency token. Every UPDATE increments it and carries
//     `where version = @expected`. `UpdatedAt` is for display only and never participates in a
//     comparison — a timestamp would have to round-trip Postgres microseconds through JSON and
//     the browser bit-exactly, and one pass through a JavaScript Date truncates to milliseconds,
//     so every second edit would 409. An integer compares exactly.
//
//   * PATCH is a full replacement of the mutable fields, not a merge. With records and
//     System.Text.Json an absent property and an explicit null both deserialize to null, so
//     merge-patch semantics cannot be expressed here at all. The client always sends every
//     field (it is editing a row it just loaded), and a null means CLEAR THE FIELD — which the
//     import-cleanup workflow genuinely needs.

/// <summary>A client as it appears in a listing.</summary>
public sealed record ClientSummary(
    Guid Id,
    string Name,
    string? Industry,
    string? Location,
    string Status,
    int ContactCount,
    long Version,
    DateTimeOffset UpdatedAt);

/// <summary>
/// One client with its contacts. <paramref name="Status"/>, <paramref name="AcquiredAt"/> and
/// <paramref name="LostReason"/> move only through <c>POST /clients/{id}/status</c> — PATCH
/// replaces the descriptive fields and deliberately cannot touch the lifecycle ones, which is
/// what keeps the <c>clients_lost_reason_shape</c> CHECK unviolable from a field edit.
/// </summary>
/// <param name="Website">
/// An absolute <c>http(s)</c> URL with an ASCII host, or null. Normalized by
/// <see cref="ClientValidation"/> on the way in rather than sanitized on the way out, because the
/// client renders it straight into an <c>href</c>. What the API vouches for is narrow and exact:
/// the value is safe <em>in an href</em> and its visible text names the host a browser will dial.
/// It is not a verified identity — see <see cref="ClientValidation.TryReadWebsite"/>.
/// </param>
/// <param name="WhatTheyDo">Free text: what this organisation actually does.</param>
public sealed record ClientDetail(
    Guid Id,
    string Name,
    string? Industry,
    string? Location,
    string? Website,
    string? WhatTheyDo,
    string? Notes,
    string Status,
    DateOnly? AcquiredAt,
    string? Source,
    string? Owner,
    string? LostReason,
    IReadOnlyList<ContactSummary> Contacts,
    long Version,
    DateTimeOffset CreatedAt,
    string CreatedBy,
    DateTimeOffset UpdatedAt,
    string UpdatedBy);

/// <summary>One contact belonging to a client.</summary>
public sealed record ContactSummary(
    Guid Id,
    string? FullName,
    string? Email,
    string? RoleTitle,
    string? Notes,
    long Version,
    DateTimeOffset UpdatedAt);

/// <summary>
/// A page of clients. <paramref name="Total"/> is the number of rows matching the filters
/// before paging, so the UI can render "51–100 of 190" rather than guessing whether there is
/// another page.
/// </summary>
public sealed record ClientListResponse(
    IReadOnlyList<ClientSummary> Clients,
    int Total,
    int Limit,
    int Offset);

/// <summary>
/// A client's most recent outreach touch, trimmed to what a recency check needs. Rides on the
/// bulk read only — the full log stays behind <c>GET /clients/{id}/interactions</c>.
/// </summary>
public sealed record LastInteraction(
    string Kind,
    DateOnly OccurredOn,
    string Summary,
    DateOnly? FollowUpOn);

/// <summary>
/// One row of the bulk read: the client exactly as <c>GET /clients/{id}</c> would return it
/// (contacts included), plus its latest touch. Composed rather than flattened so a field added
/// to <see cref="ClientDetail"/> can never be forgotten here.
/// </summary>
public sealed record ClientDetailRow(ClientDetail Client, LastInteraction? LastInteraction);

/// <summary>
/// A page of full client records — <c>GET /clients/details</c>. Same filters, paging and
/// <paramref name="Total"/> semantics as <see cref="ClientListResponse"/>.
/// </summary>
public sealed record ClientDetailListResponse(
    IReadOnlyList<ClientDetailRow> Clients,
    int Total,
    int Limit,
    int Offset);

/// <summary>
/// The result of creating a client.
/// </summary>
/// <param name="Warning">
/// A soft duplicate-name notice, or null. There is deliberately no unique constraint on
/// <c>clients.name</c> — real companies share names and the seeded data contains four distinct
/// prospects all recorded as "Unknown" — so this is advice to a human, not a rejection. It rides
/// alongside the created client rather than on <see cref="ClientDetail"/> itself because it is
/// only ever meaningful at the moment of creation.
/// </param>
public sealed record CreateClientResponse(ClientDetail Client, string? Warning);

/// <summary>Body of <c>POST /clients</c>.</summary>
public sealed record CreateClientRequest(
    string? Name,
    string? Industry,
    string? Location,
    string? Website,
    string? WhatTheyDo,
    string? Notes,
    string? Source,
    string? Owner);

/// <summary>
/// Body of <c>PATCH /clients/{id}</c>. <paramref name="ExpectedVersion"/> is required — an
/// optional concurrency token is decorative protection the day the UI forgets to send it.
/// Carries <paramref name="Source"/> and <paramref name="Owner"/> but never status — see
/// <see cref="ChangeClientStatusRequest"/>.
/// </summary>
public sealed record UpdateClientRequest(
    string? Name,
    string? Industry,
    string? Location,
    string? Website,
    string? WhatTheyDo,
    string? Notes,
    string? Source,
    string? Owner,
    long? ExpectedVersion);

/// <summary>
/// Body of <c>POST /clients/{id}/status</c> — the only way a client's status moves. A dedicated
/// endpoint rather than more PATCH fields because a transition is an event (it appends to
/// <c>client_status_history</c> and may set <c>acquired_at</c>), and because folding status into
/// a full-replacement PATCH would put it one forgotten form field away from being wiped.
/// <paramref name="LostReason"/> only accompanies a change to <c>lost</c>.
/// </summary>
public sealed record ChangeClientStatusRequest(string? Status, string? LostReason, long? ExpectedVersion);

/// <summary>One recorded status transition. Immutable — there is no version and no update.</summary>
public sealed record StatusHistoryEntry(
    Guid Id,
    string FromStatus,
    string ToStatus,
    DateTimeOffset ChangedAt,
    string ChangedBy);

/// <summary>
/// One logged interaction with a client. Unlike <see cref="ContactSummary"/> this carries
/// <paramref name="CreatedBy"/> — who logged the touch is half the point of a log.
/// </summary>
public sealed record InteractionSummary(
    Guid Id,
    Guid? ContactId,
    string Kind,
    DateOnly OccurredOn,
    string Summary,
    DateOnly? FollowUpOn,
    long Version,
    DateTimeOffset CreatedAt,
    string CreatedBy,
    DateTimeOffset UpdatedAt);

/// <summary>Body of <c>POST /clients/{id}/interactions</c>.</summary>
public sealed record CreateInteractionRequest(
    string? Kind,
    DateOnly? OccurredOn,
    string? Summary,
    DateOnly? FollowUpOn,
    Guid? ContactId);

/// <summary>Body of <c>PATCH /clients/{id}/interactions/{interactionId}</c>.</summary>
public sealed record UpdateInteractionRequest(
    string? Kind,
    DateOnly? OccurredOn,
    string? Summary,
    DateOnly? FollowUpOn,
    Guid? ContactId,
    long? ExpectedVersion);

/// <summary>Body of <c>POST /clients/{id}/contacts</c>.</summary>
public sealed record CreateContactRequest(string? FullName, string? Email, string? RoleTitle, string? Notes);

/// <summary>Body of <c>PATCH /clients/{id}/contacts/{contactId}</c>.</summary>
public sealed record UpdateContactRequest(
    string? FullName,
    string? Email,
    string? RoleTitle,
    string? Notes,
    long? ExpectedVersion);
