using System.Diagnostics.CodeAnalysis;

namespace LoopedIn.Api.Models;

/// <summary>The normalized, storable form of a campaign's mutable fields.</summary>
public sealed record CampaignFields(string Name, string? Brief);

/// <summary>The normalized, storable form of a message's mutable fields.</summary>
public sealed record CampaignMessageFields(string Subject, string Body, Guid? ContactId);

/// <summary>
/// Normalization and validation for the <c>/campaigns</c> request bodies.
/// </summary>
/// <remarks>
/// The limits here <b>mirror the CHECK constraints</b> in <c>Migrations/0004_campaigns.sql</c>,
/// for the reason <see cref="ClientValidation"/> states: without the mirror a too-long value
/// reaches Postgres and surfaces as a 503 instead of the 400 it is. If a constraint changes,
/// change both. The generic helpers (<see cref="ClientValidation.Clean"/>,
/// <see cref="ClientValidation.Fits"/>, the paging clamps, <see cref="ClientValidation.SearchPattern"/>)
/// are reused from there rather than cloned.
/// </remarks>
public static class CampaignValidation
{
    public const int MaxNameLength = 200;
    public const int MaxBriefLength = 4000;
    public const int MaxSubjectLength = 200;

    /// <summary>
    /// Deliberately past the notes tier (4000): the body is the artifact being drafted, not an
    /// annotation on one. See the 0004 migration header.
    /// </summary>
    public const int MaxBodyLength = 10000;

    /// <summary>
    /// Mirrors the <c>campaign_messages_state_allowed</c> CHECK — change both together, along
    /// with <c>CAMPAIGN_MESSAGE_STATES</c> in <c>frontend/app/(app)/campaigns/types.ts</c>,
    /// <c>CampaignMessageState</c> in <c>mcp/looped_in_mcp/tools/campaigns.py</c>, and the
    /// count columns in <c>CampaignStore.ListAsync</c> / <see cref="CampaignSummary"/>.
    /// </summary>
    public static readonly IReadOnlyList<string> CampaignMessageStates =
    [
        "drafted", "approved", "sent", "skipped",
    ];

    public static bool TryReadCampaign(
        CreateCampaignRequest? request,
        [NotNullWhen(true)] out CampaignFields? fields,
        [NotNullWhen(false)] out string? error) =>
        TryReadCampaign(request?.Name, request?.Brief, out fields, out error);

    public static bool TryReadCampaign(
        UpdateCampaignRequest? request,
        [NotNullWhen(true)] out CampaignFields? fields,
        [NotNullWhen(false)] out string? error) =>
        TryReadCampaign(request?.Name, request?.Brief, out fields, out error);

    private static bool TryReadCampaign(
        string? name,
        string? brief,
        [NotNullWhen(true)] out CampaignFields? fields,
        [NotNullWhen(false)] out string? error)
    {
        fields = null;

        var trimmedName = ClientValidation.Clean(name);
        if (trimmedName is null)
        {
            error = "A campaign needs a name.";
            return false;
        }

        if (!ClientValidation.Fits(trimmedName, MaxNameLength, "name", out error)
            || !ClientValidation.Fits(ClientValidation.Clean(brief), MaxBriefLength, "brief", out error))
        {
            return false;
        }

        fields = new CampaignFields(trimmedName, ClientValidation.Clean(brief));
        error = null;
        return true;
    }

    public static bool TryReadMessage(
        CreateCampaignMessageRequest? request,
        [NotNullWhen(true)] out CampaignMessageFields? fields,
        [NotNullWhen(false)] out string? error) =>
        TryReadMessage(request?.Subject, request?.Body, request?.ContactId, out fields, out error);

    public static bool TryReadMessage(
        UpdateCampaignMessageRequest? request,
        [NotNullWhen(true)] out CampaignMessageFields? fields,
        [NotNullWhen(false)] out string? error) =>
        TryReadMessage(request?.Subject, request?.Body, request?.ContactId, out fields, out error);

    private static bool TryReadMessage(
        string? subject,
        string? body,
        Guid? contactId,
        [NotNullWhen(true)] out CampaignMessageFields? fields,
        [NotNullWhen(false)] out string? error)
    {
        fields = null;

        var cleanSubject = ClientValidation.Clean(subject);
        if (cleanSubject is null)
        {
            error = "A message needs a subject.";
            return false;
        }

        var cleanBody = ClientValidation.Clean(body);
        if (cleanBody is null)
        {
            error = "A message needs a body.";
            return false;
        }

        if (!ClientValidation.Fits(cleanSubject, MaxSubjectLength, "subject", out error)
            || !ClientValidation.Fits(cleanBody, MaxBodyLength, "body", out error))
        {
            return false;
        }

        fields = new CampaignMessageFields(cleanSubject, cleanBody, contactId);
        error = null;
        return true;
    }

    public static bool TryReadMessageState(
        ChangeCampaignMessageStateRequest? request,
        [NotNullWhen(true)] out string? state,
        [NotNullWhen(false)] out string? error)
    {
        var value = ClientValidation.Clean(request?.State);
        if (value is null || !CampaignMessageStates.Contains(value))
        {
            state = null;
            error = $"\"{value ?? "(empty)"}\" isn't a state. "
                + $"Use one of: {string.Join(", ", CampaignMessageStates)}.";
            return false;
        }

        state = value;
        error = null;
        return true;
    }
}
