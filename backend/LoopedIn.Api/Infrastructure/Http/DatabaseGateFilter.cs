using LoopedIn.Api.Infrastructure.Database;
using Npgsql;

namespace LoopedIn.Api.Infrastructure.Http;

/// <summary>
/// The shared preamble for every database-backed route group, as composition rather than a
/// helper each handler remembers to call: refuse when the database is unusable, refuse when the
/// validated token carries no subject, and translate Postgres failures into the status codes the
/// UI knows how to render.
/// </summary>
/// <remarks>
/// <para>
/// <c>DocumentEndpoints</c> hand-rolls the equivalent as <c>WithStoreAsync</c>. Doing that again
/// here would be the second copy, so this is the pattern future route modules follow: state the
/// gate once on the group with <c>AddEndpointFilter&lt;DatabaseGateFilter&gt;()</c> and a new
/// route cannot forget it.
/// </para>
/// <para>
/// <b>Unique violations are a 409, not a 503.</b> Every duplicate-email path is checked before
/// the insert, but a check-then-insert has a race, and the losing request must land on the same
/// answer the pre-check gives — not a 503 implying the database is broken, and certainly not a 500.
/// </para>
/// </remarks>
public sealed class DatabaseGateFilter : IEndpointFilter
{
    private readonly DatabaseState _state;

    public DatabaseGateFilter(DatabaseState state)
    {
        _state = state;
    }

    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        if (!_state.Available)
        {
            return Results.Problem(
                _state.Reason ?? "The database is unavailable.",
                statusCode: StatusCodes.Status503ServiceUnavailable);
        }

        if (context.HttpContext.User.GetSubject() is null)
        {
            // The token validated but names nobody. Refuse rather than write a placeholder into
            // created_by/updated_by.
            return Results.Problem(
                "The authenticated token carries no usable subject claim.",
                statusCode: StatusCodes.Status401Unauthorized);
        }

        try
        {
            return await next(context);
        }
        catch (PostgresException ex) when (ex.SqlState == PostgresErrorCodes.UniqueViolation)
        {
            return Results.Problem(
                ex.ConstraintName == "contacts_client_email_uniq"
                    ? "Another contact with that email address was just added to this client. Reload and try again."
                    : "That change conflicts with an existing record. Reload and try again.",
                statusCode: StatusCodes.Status409Conflict);
        }
        catch (NpgsqlException ex)
        {
            // Covers connection failures, command timeouts, and every Postgres error that is not
            // one this API turns into a specific answer. From the caller's side the database is
            // simply unavailable — the same shape unconfigured storage reports.
            return Results.Problem(
                $"The database is unavailable: {ex.Message}",
                statusCode: StatusCodes.Status503ServiceUnavailable);
        }
    }
}
