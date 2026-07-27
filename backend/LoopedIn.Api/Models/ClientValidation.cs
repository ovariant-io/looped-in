using System.Diagnostics.CodeAnalysis;

namespace LoopedIn.Api.Models;

/// <summary>The normalized, storable form of a client's mutable fields.</summary>
public sealed record ClientFields(string Name, string? Industry, string? Location, string? Notes);

/// <summary>The normalized, storable form of a contact's mutable fields.</summary>
public sealed record ContactFields(string? FullName, string? Email, string? RoleTitle, string? Notes);

/// <summary>
/// Normalization and validation for the <c>/clients</c> request bodies.
/// </summary>
/// <remarks>
/// <para>
/// The limits here <b>mirror the CHECK constraints</b> in
/// <c>Migrations/0001_clients_contacts.sql</c>. That duplication is the point: without it a
/// too-long name reaches Postgres, violates a check, and surfaces as a 503 (or worse, a 500)
/// instead of the 400 it is. If a constraint changes, change both.
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
    public const int MaxNotesLength = 4000;
    public const int MaxFullNameLength = 200;
    public const int MaxEmailLength = 320;
    public const int MaxRoleTitleLength = 200;

    /// <summary>Largest page the list endpoint will return, whatever <c>?limit=</c> asks for.</summary>
    public const int MaxPageSize = 200;

    /// <summary>Page size when <c>?limit=</c> is absent or unusable.</summary>
    public const int DefaultPageSize = 50;

    public static bool TryReadClient(
        CreateClientRequest? request,
        [NotNullWhen(true)] out ClientFields? fields,
        [NotNullWhen(false)] out string? error) =>
        TryReadClient(request?.Name, request?.Industry, request?.Location, request?.Notes, out fields, out error);

    public static bool TryReadClient(
        UpdateClientRequest? request,
        [NotNullWhen(true)] out ClientFields? fields,
        [NotNullWhen(false)] out string? error) =>
        TryReadClient(request?.Name, request?.Industry, request?.Location, request?.Notes, out fields, out error);

    private static bool TryReadClient(
        string? name,
        string? industry,
        string? location,
        string? notes,
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

        if (!Fits(trimmedName, MaxNameLength, "name", out error)
            || !Fits(Clean(industry), MaxIndustryLength, "industry", out error)
            || !Fits(Clean(location), MaxLocationLength, "location", out error)
            || !Fits(Clean(notes), MaxNotesLength, "notes", out error))
        {
            return false;
        }

        fields = new ClientFields(trimmedName, Clean(industry), Clean(location), Clean(notes));
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
