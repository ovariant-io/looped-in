using System.Security.Claims;

namespace LoopedIn.Api.Infrastructure.Http;

/// <summary>
/// One definition of "who is calling".
/// </summary>
/// <remarks>
/// The subject of a Clerk token is its <c>sub</c> claim, but it does not always arrive under
/// that name: <c>JwtBearerOptions.MapInboundClaims</c> defaults to true, which rewrites
/// <c>sub</c> to <see cref="ClaimTypes.NameIdentifier"/>. Reading only one of the two works
/// until someone turns mapping off, at which point every caller silently becomes anonymous —
/// so the fallback belongs in one place rather than repeated at each call site.
/// </remarks>
public static class ClaimsPrincipalExtensions
{
    /// <summary>
    /// The caller's Clerk user id, or null when the token carries no usable subject.
    /// </summary>
    public static string? GetSubject(this ClaimsPrincipal user)
    {
        var subject = user.FindFirstValue(ClaimTypes.NameIdentifier) ?? user.FindFirstValue("sub");
        return string.IsNullOrWhiteSpace(subject) ? null : subject;
    }

    /// <summary>
    /// The caller's Clerk user id, for handlers that run behind a filter which has already
    /// rejected a subject-less token (see <see cref="DatabaseGateFilter"/>).
    /// </summary>
    /// <exception cref="InvalidOperationException">
    /// If the token has no subject after all — a routing mistake, not a bad request. It throws
    /// rather than returning a placeholder because the value ends up in <c>created_by</c> and
    /// <c>updated_by</c>: inventing an actor id writes a lie into the audit columns.
    /// </exception>
    public static string RequireSubject(this ClaimsPrincipal user) =>
        user.GetSubject()
            ?? throw new InvalidOperationException(
                "The authenticated token carries no usable subject claim. Endpoints that call "
                    + "RequireSubject must sit behind a filter that rejects this case first.");
}
