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
    int ContactCount,
    long Version,
    DateTimeOffset UpdatedAt);

/// <summary>One client with its contacts.</summary>
public sealed record ClientDetail(
    Guid Id,
    string Name,
    string? Industry,
    string? Location,
    string? Notes,
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
public sealed record CreateClientRequest(string? Name, string? Industry, string? Location, string? Notes);

/// <summary>
/// Body of <c>PATCH /clients/{id}</c>. <paramref name="ExpectedVersion"/> is required — an
/// optional concurrency token is decorative protection the day the UI forgets to send it.
/// </summary>
public sealed record UpdateClientRequest(
    string? Name,
    string? Industry,
    string? Location,
    string? Notes,
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
