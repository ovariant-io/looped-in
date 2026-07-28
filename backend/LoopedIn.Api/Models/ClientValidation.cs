using System.Diagnostics.CodeAnalysis;

namespace LoopedIn.Api.Models;

/// <summary>The normalized, storable form of a client's mutable fields.</summary>
public sealed record ClientFields(
    string Name,
    string? Industry,
    string? Location,
    string? Website,
    string? WhatTheyDo,
    string? Notes,
    string? Source,
    string? Owner);

/// <summary>The normalized, storable form of a contact's mutable fields.</summary>
public sealed record ContactFields(string? FullName, string? Email, string? RoleTitle, string? Notes);

/// <summary>The normalized, storable form of a status transition.</summary>
public sealed record StatusChange(string Status, string? LostReason);

/// <summary>The normalized, storable form of an interaction's mutable fields.</summary>
public sealed record InteractionFields(
    string Kind, DateOnly OccurredOn, string Summary, DateOnly? FollowUpOn, Guid? ContactId);

/// <summary>
/// Normalization and validation for the <c>/clients</c> request bodies.
/// </summary>
/// <remarks>
/// <para>
/// The limits here <b>mirror the CHECK constraints</b> in
/// <c>Migrations/0001_clients_contacts.sql</c>, <c>0002_acquisition_lifecycle.sql</c> and
/// <c>0003_client_profile.sql</c>. That duplication is the point: without it a too-long name
/// reaches Postgres, violates a check, and surfaces as a 503 (or worse, a 500) instead of the 400
/// it is. If a constraint changes, change both.
/// </para>
/// <para>
/// Pure argument-in/result-out, with no <c>HttpContext</c> and no database in sight, so it is
/// unit-testable the day this repo grows a test project.
/// </para>
/// </remarks>
public static class ClientValidation
{
    public const int MaxNameLength = 200;
    public const int MaxIndustryLength = 100;
    public const int MaxLocationLength = 100;
    public const int MaxWebsiteLength = 500;
    public const int MaxWhatTheyDoLength = 2000;
    public const int MaxNotesLength = 4000;
    public const int MaxFullNameLength = 200;
    public const int MaxEmailLength = 320;
    public const int MaxRoleTitleLength = 200;
    public const int MaxSourceLength = 100;
    public const int MaxOwnerLength = 200;
    public const int MaxLostReasonLength = 500;
    public const int MaxInteractionSummaryLength = 2000;

    /// <summary>Mirrors the <c>clients_status_allowed</c> CHECK — change both together.</summary>
    public static readonly IReadOnlyList<string> ClientStatuses =
    [
        "lead", "contacted", "in_discussion", "proposal_sent",
        "active_client", "former_client", "lost", "do_not_contact",
    ];

    /// <summary>Mirrors the <c>interactions.kind</c> CHECK — change both together.</summary>
    public static readonly IReadOnlyList<string> InteractionKinds =
    [
        "email", "call", "meeting", "linkedin", "proposal", "note", "other",
    ];

    /// <summary>Largest page the list endpoint will return, whatever <c>?limit=</c> asks for.</summary>
    public const int MaxPageSize = 200;

    /// <summary>Page size when <c>?limit=</c> is absent or unusable.</summary>
    public const int DefaultPageSize = 50;

    public static bool TryReadClient(
        CreateClientRequest? request,
        [NotNullWhen(true)] out ClientFields? fields,
        [NotNullWhen(false)] out string? error) =>
        TryReadClient(
            request?.Name, request?.Industry, request?.Location, request?.Website,
            request?.WhatTheyDo, request?.Notes, request?.Source, request?.Owner,
            out fields, out error);

    public static bool TryReadClient(
        UpdateClientRequest? request,
        [NotNullWhen(true)] out ClientFields? fields,
        [NotNullWhen(false)] out string? error) =>
        TryReadClient(
            request?.Name, request?.Industry, request?.Location, request?.Website,
            request?.WhatTheyDo, request?.Notes, request?.Source, request?.Owner,
            out fields, out error);

    private static bool TryReadClient(
        string? name,
        string? industry,
        string? location,
        string? website,
        string? whatTheyDo,
        string? notes,
        string? source,
        string? owner,
        [NotNullWhen(true)] out ClientFields? fields,
        [NotNullWhen(false)] out string? error)
    {
        fields = null;

        var trimmedName = Clean(name);
        if (trimmedName is null)
        {
            error = "A client needs a name.";
            return false;
        }

        // Owner is an opaque Clerk subject — length is the only thing worth checking.
        if (!Fits(trimmedName, MaxNameLength, "name", out error)
            || !Fits(Clean(industry), MaxIndustryLength, "industry", out error)
            || !Fits(Clean(location), MaxLocationLength, "location", out error)
            || !Fits(Clean(whatTheyDo), MaxWhatTheyDoLength, "\"what they do\"", out error)
            || !Fits(Clean(notes), MaxNotesLength, "notes", out error)
            || !Fits(Clean(source), MaxSourceLength, "source", out error)
            || !Fits(Clean(owner), MaxOwnerLength, "owner", out error))
        {
            return false;
        }

        // Last, because it is the one field that rewrites its input — see TryReadWebsite. Its
        // own length check runs against the NORMALIZED value, which is what reaches the column.
        if (!TryReadWebsite(website, out var normalizedWebsite, out error))
        {
            return false;
        }

        fields = new ClientFields(
            trimmedName,
            Clean(industry),
            Clean(location),
            normalizedWebsite,
            Clean(whatTheyDo),
            Clean(notes),
            Clean(source),
            Clean(owner));
        error = null;
        return true;
    }

    /// <summary>
    /// Normalizes a website to an absolute <c>http(s)</c> URL, or explains why it is not one.
    /// Absent stays absent: <paramref name="website"/> is null for a blank value and that is a
    /// success, not a failure.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>The only field here that rewrites its input.</b> People type and paste
    /// <c>looped-in.com.au</c>, not <c>https://looped-in.com.au</c>, and a scheme-less string in an
    /// <c>href</c> is a <em>relative path</em> — the link would navigate to <c>/clients/looped-in.com.au</c>
    /// rather than off-site. Prepending the scheme at the boundary means one canonical stored form,
    /// so nothing downstream has to guess.
    /// </para>
    /// <para>
    /// <b>The scheme allow-list is a security control, not tidiness.</b> The detail page renders
    /// the stored value straight into an anchor, so <c>javascript:</c> and <c>data:</c> URLs have to
    /// be refused here — at the one boundary every write passes through — rather than filtered at
    /// each render site, where the next new render site forgets. Both shapes fail below: neither
    /// carries <c>://</c>, so each is prefixed and then fails to parse as an http(s) URL with a
    /// dotted host.
    /// </para>
    /// <para>
    /// Deliberately looser than a URL validator: no reachability check, no TLD list, no
    /// lowercasing or trailing-slash normalization. A stored value should still read as the thing
    /// the user typed. Unlike <see cref="IsPlausibleEmail"/> this has no importer to stay
    /// equivalent to — <c>scripts/import_clients.py</c> never writes this column, so there is no
    /// seeded value a strict rule here could make uneditable.
    /// </para>
    /// </remarks>
    public static bool TryReadWebsite(
        string? value,
        out string? website,
        [NotNullWhen(false)] out string? error)
    {
        website = null;
        error = null;

        var trimmed = Clean(value);
        if (trimmed is null)
        {
            return true;
        }

        // Interior whitespace is a typo, not an address. (A legitimate space is already %20.)
        if (trimmed.Any(char.IsWhiteSpace))
        {
            error = $"\"{trimmed}\" doesn't look like a web address — it contains a space.";
            return false;
        }

        var candidate = trimmed.Contains("://", StringComparison.Ordinal)
            ? trimmed
            : $"https://{trimmed}";

        // Against the normalized value: the prefix is stored, so it is the prefix that has to fit
        // the column. Checked before the parse so an absurd input fails with the useful message.
        if (!Fits(candidate, MaxWebsiteLength, "website", out error))
        {
            return false;
        }

        // Userinfo is refused for two reasons at once. It is how `mailto:someone@example.com`
        // sneaks through — the `@` makes `mailto:someone` a username rather than a bad port, so
        // the address parses as a valid https URL for host example.com and an email would be
        // silently stored as a website. And on a list every signed-in user can edit,
        // `https://looped-in.com.au@evil.com` is a link that reads as the client's own domain and
        // navigates somewhere else. No company homepage carries credentials; refusing costs
        // nothing.
        if (!Uri.TryCreate(candidate, UriKind.Absolute, out var uri)
            || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
            || uri.UserInfo.Length > 0
            || !uri.Host.Contains('.', StringComparison.Ordinal))
        {
            error = $"\"{trimmed}\" doesn't look like a web address. "
                + "Use something like looped-in.com.au or https://looped-in.com.au.";
            return false;
        }

        website = candidate;
        return true;
    }

    public static bool TryReadStatusChange(
        ChangeClientStatusRequest? request,
        [NotNullWhen(true)] out StatusChange? change,
        [NotNullWhen(false)] out string? error)
    {
        change = null;

        var status = Clean(request?.Status);
        if (status is null || !ClientStatuses.Contains(status))
        {
            error = $"\"{status ?? "(empty)"}\" isn't a status. Use one of: {string.Join(", ", ClientStatuses)}.";
            return false;
        }

        var lostReason = Clean(request?.LostReason);
        if (!Fits(lostReason, MaxLostReasonLength, "lost reason", out error))
        {
            return false;
        }

        // Mirrors the clients_lost_reason_shape CHECK, so a stray reason is a 400 and never a
        // constraint violation. Transitioning to lost WITHOUT a reason is fine.
        if (lostReason is not null && status != "lost")
        {
            error = "A lost reason only accompanies a change to lost.";
            return false;
        }

        change = new StatusChange(status, lostReason);
        error = null;
        return true;
    }

    public static bool TryReadInteraction(
        CreateInteractionRequest? request,
        [NotNullWhen(true)] out InteractionFields? fields,
        [NotNullWhen(false)] out string? error) =>
        TryReadInteraction(
            request?.Kind, request?.OccurredOn, request?.Summary, request?.FollowUpOn,
            request?.ContactId, out fields, out error);

    public static bool TryReadInteraction(
        UpdateInteractionRequest? request,
        [NotNullWhen(true)] out InteractionFields? fields,
        [NotNullWhen(false)] out string? error) =>
        TryReadInteraction(
            request?.Kind, request?.OccurredOn, request?.Summary, request?.FollowUpOn,
            request?.ContactId, out fields, out error);

    private static bool TryReadInteraction(
        string? kind,
        DateOnly? occurredOn,
        string? summary,
        DateOnly? followUpOn,
        Guid? contactId,
        [NotNullWhen(true)] out InteractionFields? fields,
        [NotNullWhen(false)] out string? error)
    {
        fields = null;

        var cleanKind = Clean(kind);
        if (cleanKind is null || !InteractionKinds.Contains(cleanKind))
        {
            error = $"\"{cleanKind ?? "(empty)"}\" isn't an interaction kind. "
                + $"Use one of: {string.Join(", ", InteractionKinds)}.";
            return false;
        }

        if (occurredOn is not { } occurred)
        {
            error = "An interaction needs the date it occurred.";
            return false;
        }

        var cleanSummary = Clean(summary);
        if (cleanSummary is null)
        {
            error = "An interaction needs a summary.";
            return false;
        }

        if (!Fits(cleanSummary, MaxInteractionSummaryLength, "summary", out error))
        {
            return false;
        }

        fields = new InteractionFields(cleanKind, occurred, cleanSummary, followUpOn, contactId);
        error = null;
        return true;
    }

    public static bool TryReadContact(
        CreateContactRequest? request,
        [NotNullWhen(true)] out ContactFields? fields,
        [NotNullWhen(false)] out string? error) =>
        TryReadContact(request?.FullName, request?.Email, request?.RoleTitle, request?.Notes, out fields, out error);

    public static bool TryReadContact(
        UpdateContactRequest? request,
        [NotNullWhen(true)] out ContactFields? fields,
        [NotNullWhen(false)] out string? error) =>
        TryReadContact(request?.FullName, request?.Email, request?.RoleTitle, request?.Notes, out fields, out error);

    private static bool TryReadContact(
        string? fullName,
        string? email,
        string? roleTitle,
        string? notes,
        [NotNullWhen(true)] out ContactFields? fields,
        [NotNullWhen(false)] out string? error)
    {
        fields = null;

        var cleanName = Clean(fullName);
        var cleanEmail = Clean(email);

        // Mirrors the contacts_identifiable CHECK. A contact with neither is a row with no way
        // to identify a person; a client with no contacts at all is the supported shape instead.
        if (cleanName is null && cleanEmail is null)
        {
            error = "A contact needs a name or an email address.";
            return false;
        }

        if (!Fits(cleanName, MaxFullNameLength, "name", out error)
            || !Fits(cleanEmail, MaxEmailLength, "email address", out error)
            || !Fits(Clean(roleTitle), MaxRoleTitleLength, "role", out error)
            || !Fits(Clean(notes), MaxNotesLength, "notes", out error))
        {
            return false;
        }

        if (cleanEmail is not null && !IsPlausibleEmail(cleanEmail))
        {
            error = $"\"{cleanEmail}\" doesn't look like an email address. Leave the field empty and "
                + "put the original value in notes if it isn't one.";
            return false;
        }

        fields = new ContactFields(cleanName, cleanEmail, Clean(roleTitle), Clean(notes));
        error = null;
        return true;
    }

    /// <summary>
    /// Clamps a requested page size into <c>[1, <see cref="MaxPageSize"/>]</c>, falling back to
    /// <see cref="DefaultPageSize"/> when absent or nonsensical.
    /// </summary>
    public static int PageSize(int? limit) => limit switch
    {
        null or <= 0 => DefaultPageSize,
        > MaxPageSize => MaxPageSize,
        var value => value.Value,
    };

    /// <summary>A negative offset is a client bug, not a request to page backwards from the end.</summary>
    public static int PageOffset(int? offset) => offset is > 0 ? offset.Value : 0;

    /// <summary>
    /// A recognised status for <c>?status=</c>, or null meaning "no filter".
    /// </summary>
    /// <remarks>
    /// An unrecognised value is <b>ignored rather than matched literally</b>. Passing it through
    /// would compare <c>status = 'bogus'</c>, which matches nothing and renders as an empty list —
    /// indistinguishable, to whoever is looking, from a database with no clients in it. The
    /// clients page already degrades a hand-typed value this way before it builds the query; doing
    /// it here as well means a direct caller (curl, an MCP tool) gets the same answer as the
    /// screen. <c>?industry=</c> gets no equivalent because it is free text with no closed set to
    /// check against.
    /// </remarks>
    public static string? StatusFilter(string? status)
    {
        var value = Clean(status);
        return value is not null && ClientStatuses.Contains(value) ? value : null;
    }

    /// <summary>
    /// Turns a search term into an <c>ILIKE</c> pattern with the wildcards escaped, so searching
    /// for <c>100%</c> finds the literal string rather than everything starting with "100".
    /// Returns null for a blank term, which the query reads as "no filter".
    /// </summary>
    /// <remarks>
    /// Paired with <c>escape '\'</c> in the SQL. The pattern travels as a parameter, so the
    /// backslashes here are literal and never re-interpreted by the SQL parser.
    /// </remarks>
    public static string? SearchPattern(string? search)
    {
        var term = Clean(search);
        if (term is null)
        {
            return null;
        }

        var escaped = term
            .Replace("\\", "\\\\", StringComparison.Ordinal)
            .Replace("%", "\\%", StringComparison.Ordinal)
            .Replace("_", "\\_", StringComparison.Ordinal);

        return $"%{escaped}%";
    }

    /// <summary>Trims, and treats an empty or whitespace-only value as absent.</summary>
    public static string? Clean(string? value)
    {
        var trimmed = value?.Trim();
        return string.IsNullOrEmpty(trimmed) ? null : trimmed;
    }

    private static bool Fits(string? value, int max, string label, [NotNullWhen(false)] out string? error)
    {
        if (value is not null && value.Length > max)
        {
            error = $"That {label} is {value.Length} characters; the limit is {max}.";
            return false;
        }

        error = null;
        return true;
    }

    /// <summary>
    /// A deliberately conservative shape check: one <c>@</c>, something either side of it, a dot
    /// in the domain, no whitespace.
    /// </summary>
    /// <remarks>
    /// It is not RFC 5322 and does not try to be — the only job is to reject the things the
    /// source spreadsheet actually contained in its email column (a LinkedIn URL, a status note,
    /// a person's name and role, an address with a space in the domain) so they land in notes
    /// instead.
    /// <para>
    /// <b>This must stay equivalent to <c>is_plausible_email</c> in
    /// <c>scripts/import_clients.py</c>.</b> The importer writes straight to Postgres and bypasses
    /// request validation, so this is the first code to judge a seeded address — and it only does
    /// so when someone tries to save an edit. A rule here that is stricter than the importer's
    /// does not reject bad data; it makes rows that are already stored impossible to edit.
    /// </para>
    /// <para>
    /// A <b>trailing dot is tolerated</b> for exactly that reason: three seeded addresses end in a
    /// full stop, and they are real contacts. (It is also a legitimate fully-qualified domain.)
    /// </para>
    /// </remarks>
    public static bool IsPlausibleEmail(string value)
    {
        if (value.Length > MaxEmailLength || value.Any(char.IsWhiteSpace))
        {
            return false;
        }

        var at = value.IndexOf('@', StringComparison.Ordinal);
        if (at <= 0 || at != value.LastIndexOf('@'))
        {
            return false;
        }

        var domain = value[(at + 1)..];
        return domain.Length >= 3
            && domain.Contains('.', StringComparison.Ordinal)
            && !domain.StartsWith('.');
    }
}
