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
/// <para>
/// <b>Foreign-key violations are a 409 for the same reason.</b> Every store validates its
/// references inside the writing statement, so a 23503 that still surfaces means the referenced
/// row was deleted between that snapshot and the constraint check — a concurrent edit, the exact
/// thing a version conflict reports, not a broken database. (A truly simultaneous delete can
/// still resolve as a deadlock, which stays a 503; without retries that window is irreducible.)
/// </para>
/// <para>
/// <b>A runtime failure is logged in full and reported in outline.</b> Npgsql's exception messages
/// name the host, port, and database they failed to reach; the 503 body is rendered verbatim to
/// whoever is signed in, so echoing it would publish the Neon endpoint to every user. The detail
/// belongs in the logs, where an operator can act on it. This is the opposite of the
/// <em>configuration</em> reasons in <see cref="DatabaseState"/>, which are written to be read by
/// the person who has to fix them and say nothing a caller could not already guess.
/// </para>
/// </remarks>
public sealed class DatabaseGateFilter : IEndpointFilter
{
    private readonly DatabaseState _state;
    private readonly ILogger<DatabaseGateFilter> _logger;

    public DatabaseGateFilter(DatabaseState state, ILogger<DatabaseGateFilter> logger)
    {
        _state = state;
        _logger = logger;
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
                ex.ConstraintName switch
                {
                    "contacts_client_email_uniq" =>
                        "Another contact with that email address was just added to this client. Reload and try again.",
                    "campaign_messages_campaign_client_uniq" =>
                        "This client already has a draft in this campaign — edit that message instead of adding a second.",
                    _ => "That change conflicts with an existing record. Reload and try again.",
                },
                statusCode: StatusCodes.Status409Conflict);
        }
        catch (PostgresException ex) when (ex.SqlState == PostgresErrorCodes.ForeignKeyViolation)
        {
            return Results.Problem(
                "Something this change refers to was just deleted by someone else. Reload and try again.",
                statusCode: StatusCodes.Status409Conflict);
        }
        catch (NpgsqlException ex)
        {
            // Covers connection failures, command timeouts, and every Postgres error that is not
            // one this API turns into a specific answer. From the caller's side the database is
            // simply unavailable — the same shape unconfigured storage reports.
            _logger.LogError(
                ex,
                "A database call failed handling {Method} {Path}.",
                context.HttpContext.Request.Method,
                context.HttpContext.Request.Path);

            return Results.Problem(
                "The database is temporarily unavailable. Try again in a moment — the API logs carry "
                    + "the detail.",
                statusCode: StatusCodes.Status503ServiceUnavailable);
        }
    }
}
