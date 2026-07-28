using LoopedIn.Api.Models;
using Npgsql;
using NpgsqlTypes;

namespace LoopedIn.Api.Infrastructure.Database;

/// <summary>How a write turned out.</summary>
public enum MutationStatus
{
    /// <summary>The write happened.</summary>
    Applied,

    /// <summary>Nothing with that id exists (or, for a contact, not under that client).</summary>
    NotFound,

    /// <summary>The row exists but has moved on since the caller loaded it.</summary>
    VersionConflict,

    /// <summary>The write would collide with a row that already exists.</summary>
    Duplicate,

    /// <summary>
    /// The write names a related row that doesn't exist where it claims to — a contact id from
    /// another client, say. A caller mistake (400), not a conflict and not a missing target.
    /// </summary>
    InvalidReference,
}

/// <summary>
/// The outcome of a write, with the new state on success and a caller-facing explanation on
/// <see cref="MutationStatus.Duplicate"/>.
/// </summary>
public sealed record MutationResult<T>(MutationStatus Status, T? Value, string? Message)
    where T : class
{
    public static MutationResult<T> Applied(T value) => new(MutationStatus.Applied, value, null);

    public static MutationResult<T> NotFound() => new(MutationStatus.NotFound, null, null);

    public static MutationResult<T> VersionConflict() => new(MutationStatus.VersionConflict, null, null);

    public static MutationResult<T> Duplicate(string message) => new(MutationStatus.Duplicate, null, message);

    public static MutationResult<T> InvalidReference(string message) =>
        new(MutationStatus.InvalidReference, null, message);
}

/// <summary>
/// Every SQL statement behind <c>/clients</c>, in one place, fully parameterized.
/// </summary>
/// <remarks>
/// <para>
/// Concrete rather than behind an <c>IClientStore</c>, like <c>DocumentStore</c>: the DI
/// registration is already the substitution seam, and an interface with one implementation and
/// no consumer is ceremony. Extract one the day a second implementation or a test double needs
/// it, and not before.
/// </para>
/// <para>
/// Registered only when <c>DATABASE_URL</c> is set, so every route that resolves it sits behind
/// <c>DatabaseGateFilter</c>, which answers 503 before a handler can look for it.
/// </para>
/// </remarks>
public sealed class ClientStore
{
    /// <summary>
    /// The search and industry predicate, shared by the page query and the count that backs up
    /// the windowed total — so the two can never disagree about what "matching" means.
    /// </summary>
    private const string ListFilter = """
        (@pattern::text is null or (
                 c.name ilike @pattern escape '\'
              or c.industry ilike @pattern escape '\'
              or c.location ilike @pattern escape '\'
              or exists (
                     select 1 from contacts ct
                     where ct.client_id = c.id
                       and (ct.full_name ilike @pattern escape '\' or ct.email ilike @pattern escape '\'))))
        and (@industry::text is null or lower(c.industry) = lower(@industry))
        and (@status::text is null or c.status = @status)
        """;

    // Each of these column lists is coupled by position to its reader (ReadClient, ReadContact,
    // ReadInteraction, ReadHistoryEntry) — add a column and you renumber the ordinals in the
    // same change, or the mismatch surfaces as an InvalidCastException at runtime.
    private const string ClientColumns =
        "id, name, industry, location, website, what_they_do, notes, "
        + "status, acquired_at, source, owner, lost_reason, "
        + "version, created_at, created_by, updated_at, updated_by";

    private const string ContactColumns = "id, full_name, email, role_title, notes, version, updated_at";

    private const string InteractionColumns =
        "id, contact_id, kind, occurred_on, summary, follow_up_on, version, created_at, created_by, updated_at";

    private const string HistoryColumns = "id, from_status, to_status, changed_at, changed_by";

    private readonly NpgsqlDataSource _dataSource;

    public ClientStore(NpgsqlDataSource dataSource)
    {
        _dataSource = dataSource;
    }

    /// <summary>
    /// One page of clients, newest first.
    /// </summary>
    /// <remarks>
    /// Ordering is <c>(created_at desc, id desc)</c> and never by id alone: every seeded row
    /// shares one apply-time <c>created_at</c>, so without the tiebreak paging would be free to
    /// return the same row on two pages and skip another. At ~200 rows the <c>ilike</c> scan is
    /// the right answer; <c>pg_trgm</c> is the fix if this ever reaches five figures, not before.
    /// </remarks>
    public async Task<ClientListResponse> ListAsync(
        string? searchPattern,
        string? industry,
        string? status,
        int limit,
        int offset,
        CancellationToken cancellationToken)
    {
        var clients = new List<ClientSummary>();
        var total = 0;

        await using (var command = _dataSource.CreateCommand($"""
            select c.id, c.name, c.industry, c.location, c.status, c.version, c.updated_at,
                   (select count(*) from contacts ct where ct.client_id = c.id) as contact_count,
                   count(*) over () as total_count
            from clients c
            where {ListFilter}
            order by c.created_at desc, c.id desc
            limit @limit offset @offset
            """))
        {
            command.Parameters.Add(Text("pattern", searchPattern));
            command.Parameters.Add(Text("industry", industry));
            command.Parameters.Add(Text("status", status));
            command.Parameters.Add(Int("limit", limit));
            command.Parameters.Add(Int("offset", offset));

            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                clients.Add(new ClientSummary(
                    Id: reader.GetGuid(0),
                    Name: reader.GetString(1),
                    Industry: NullableString(reader, 2),
                    Location: NullableString(reader, 3),
                    Status: reader.GetString(4),
                    ContactCount: (int)reader.GetInt64(7),
                    Version: reader.GetInt64(5),
                    UpdatedAt: reader.GetFieldValue<DateTimeOffset>(6)));

                total = (int)reader.GetInt64(8);
            }
        }

        // The windowed count rides on the rows, so an offset past the end returns no rows and
        // therefore no total — which would render as "0 of 0" over a database full of clients.
        // Only that case pays for a second query.
        if (clients.Count == 0 && offset > 0)
        {
            total = await CountAsync(searchPattern, industry, status, cancellationToken);
        }

        return new ClientListResponse(clients, total, limit, offset);
    }

    private async Task<int> CountAsync(
        string? searchPattern,
        string? industry,
        string? status,
        CancellationToken cancellationToken)
    {
        await using var command = _dataSource.CreateCommand($"""
            select count(*) from clients c where {ListFilter}
            """);
        command.Parameters.Add(Text("pattern", searchPattern));
        command.Parameters.Add(Text("industry", industry));
        command.Parameters.Add(Text("status", status));

        return (int)(long)(await command.ExecuteScalarAsync(cancellationToken) ?? 0L);
    }

    /// <summary>One client with its contacts, or null when no such client exists.</summary>
    public async Task<ClientDetail?> FindAsync(Guid id, CancellationToken cancellationToken)
    {
        // Two statements in one command: one round trip, and the contacts cannot be read from a
        // moment other than the one the client row came from.
        await using var command = _dataSource.CreateCommand($"""
            select {ClientColumns} from clients where id = @id;
            select {ContactColumns} from contacts where client_id = @id order by created_at, id;
            """);
        command.Parameters.Add(Uuid("id", id));

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            return null;
        }

        var client = ReadClient(reader);
        await reader.NextResultAsync(cancellationToken);

        return client with { Contacts = await ReadContactsAsync(reader, cancellationToken) };
    }

    /// <summary>
    /// Creates a client, and reports whether the name is already in use.
    /// </summary>
    /// <remarks>
    /// The name check is a warning, never a rejection: <c>clients.name</c> has no unique
    /// constraint because real companies share names and the seeded data holds four distinct
    /// prospects all recorded as "Unknown". It rides in the same round trip as the insert, so
    /// the advice costs nothing.
    /// </remarks>
    public async Task<CreateClientResponse> CreateAsync(
        ClientFields fields,
        string actor,
        CancellationToken cancellationToken)
    {
        var id = Guid.CreateVersion7();

        // status / acquired_at / lost_reason are absent on purpose: a new client starts at the
        // 'lead' default and only the status-transition statement ever moves it.
        await using var command = _dataSource.CreateCommand($"""
            select count(*) from clients where lower(name) = lower(@name);
            insert into clients (id, name, industry, location, website, what_they_do, notes,
                                 source, owner, created_by, updated_by)
            values (@id, @name, @industry, @location, @website, @whatTheyDo, @notes,
                    @source, @owner, @actor, @actor)
            returning {ClientColumns};
            """);
        command.Parameters.Add(Uuid("id", id));
        command.Parameters.Add(Text("name", fields.Name));
        command.Parameters.Add(Text("industry", fields.Industry));
        command.Parameters.Add(Text("location", fields.Location));
        command.Parameters.Add(Text("website", fields.Website));
        command.Parameters.Add(Text("whatTheyDo", fields.WhatTheyDo));
        command.Parameters.Add(Text("notes", fields.Notes));
        command.Parameters.Add(Text("source", fields.Source));
        command.Parameters.Add(Text("owner", fields.Owner));
        command.Parameters.Add(Text("actor", actor));

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        await reader.ReadAsync(cancellationToken);
        var existing = reader.GetInt64(0);

        await reader.NextResultAsync(cancellationToken);
        await reader.ReadAsync(cancellationToken);
        var client = ReadClient(reader);

        return new CreateClientResponse(
            client,
            existing == 0
                ? null
                : $"A client named \"{fields.Name}\" already exists ({existing} of them). This one was "
                    + "created anyway — merge or rename them if they are the same organisation.");
    }

    /// <summary>
    /// Replaces a client's mutable fields, guarded by <paramref name="expectedVersion"/>.
    /// </summary>
    public async Task<MutationResult<ClientDetail>> UpdateAsync(
        Guid id,
        ClientFields fields,
        long expectedVersion,
        string actor,
        CancellationToken cancellationToken)
    {
        ClientDetail client;
        IReadOnlyList<ContactSummary> contacts;

        // Deliberately no status / acquired_at / lost_reason here: PATCH replacing them would
        // both bypass the history audit and put the clients_lost_reason_shape CHECK within reach
        // of a plain field edit. ChangeStatusAsync is the only writer of those columns.
        await using (var command = _dataSource.CreateCommand($"""
            update clients
            set name = @name, industry = @industry, location = @location,
                website = @website, what_they_do = @whatTheyDo, notes = @notes,
                source = @source, owner = @owner,
                version = version + 1, updated_at = now(), updated_by = @actor
            where id = @id and version = @expected
            returning {ClientColumns};
            select {ContactColumns} from contacts where client_id = @id order by created_at, id;
            """))
        {
            command.Parameters.Add(Uuid("id", id));
            command.Parameters.Add(Text("name", fields.Name));
            command.Parameters.Add(Text("industry", fields.Industry));
            command.Parameters.Add(Text("location", fields.Location));
            command.Parameters.Add(Text("website", fields.Website));
            command.Parameters.Add(Text("whatTheyDo", fields.WhatTheyDo));
            command.Parameters.Add(Text("notes", fields.Notes));
            command.Parameters.Add(Text("source", fields.Source));
            command.Parameters.Add(Text("owner", fields.Owner));
            command.Parameters.Add(Text("actor", actor));
            command.Parameters.Add(BigInt("expected", expectedVersion));

            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            if (!await reader.ReadAsync(cancellationToken))
            {
                // Zero rows means either "no such client" or "someone else got there first".
                // One extra query tells the two apart, and the caller needs to: a 404 and a 409
                // ask the user to do completely different things.
                //
                // Close first: every command here draws its own connection from the pool, so
                // running the disambiguation under an open reader would hold two at once — on
                // exactly the contended path where a 409 storm means concurrency is already high.
                await reader.CloseAsync();
                return await ClientExistsAsync(id, cancellationToken)
                    ? MutationResult<ClientDetail>.VersionConflict()
                    : MutationResult<ClientDetail>.NotFound();
            }

            client = ReadClient(reader);
            await reader.NextResultAsync(cancellationToken);
            contacts = await ReadContactsAsync(reader, cancellationToken);
        }

        return MutationResult<ClientDetail>.Applied(client with { Contacts = contacts });
    }

    /// <summary>
    /// Moves a client to a new status, guarded by <paramref name="expectedVersion"/>, recording
    /// the transition in <c>client_status_history</c> atomically with the update. The only
    /// writer of <c>status</c>, <c>acquired_at</c> and <c>lost_reason</c>.
    /// </summary>
    /// <remarks>
    /// Same-status transitions are allowed on purpose — a <c>lost → lost</c> change is how a
    /// lost reason gets corrected, since PATCH cannot touch it — and they land in the history
    /// like any other transition.
    /// </remarks>
    public async Task<MutationResult<ClientDetail>> ChangeStatusAsync(
        Guid id,
        StatusChange change,
        long expectedVersion,
        string actor,
        CancellationToken cancellationToken)
    {
        ClientDetail client;
        IReadOnlyList<ContactSummary> contacts;

        // One data-modifying CTE chain, atomic under autocommit, leaning on two documented
        // Postgres behaviours: every CTE reads the same snapshot, so `prev` sees the
        // pre-update status; and a data-modifying CTE runs exactly once even when nothing
        // selects from it — `recorded` is NOT dead code. The history insert selects from
        // `changed`, so a version conflict (empty `changed`) writes no audit row either.
        await using (var command = _dataSource.CreateCommand($"""
            with prev as (
                select status as from_status from clients where id = @id
            ),
            changed as (
                update clients
                set status      = @status,
                    acquired_at = case when @status = 'active_client'
                                       then coalesce(acquired_at, current_date)
                                       else acquired_at end,
                    lost_reason = case when @status = 'lost' then @lostReason else null end,
                    version = version + 1, updated_at = now(), updated_by = @actor
                where id = @id and version = @expected
                returning {ClientColumns}
            ),
            recorded as (
                insert into client_status_history (id, client_id, from_status, to_status, changed_by)
                select @historyId, c.id, p.from_status, c.status, @actor
                from changed c cross join prev p
            )
            select {ClientColumns} from changed;
            select {ContactColumns} from contacts where client_id = @id order by created_at, id;
            """))
        {
            command.Parameters.Add(Uuid("id", id));
            command.Parameters.Add(Text("status", change.Status));
            command.Parameters.Add(Text("lostReason", change.LostReason));
            command.Parameters.Add(Text("actor", actor));
            command.Parameters.Add(BigInt("expected", expectedVersion));
            command.Parameters.Add(Uuid("historyId", Guid.CreateVersion7()));

            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            if (!await reader.ReadAsync(cancellationToken))
            {
                // Closed before the disambiguation for the same reason as UpdateAsync: one
                // pooled connection at a time.
                await reader.CloseAsync();
                return await ClientExistsAsync(id, cancellationToken)
                    ? MutationResult<ClientDetail>.VersionConflict()
                    : MutationResult<ClientDetail>.NotFound();
            }

            client = ReadClient(reader);
            await reader.NextResultAsync(cancellationToken);
            contacts = await ReadContactsAsync(reader, cancellationToken);
        }

        return MutationResult<ClientDetail>.Applied(client with { Contacts = contacts });
    }

    /// <summary>
    /// Every status transition of a client, newest first, or null when no such client exists —
    /// so the endpoint can 404 rather than serve an empty history for a deleted id.
    /// </summary>
    public async Task<IReadOnlyList<StatusHistoryEntry>?> ListStatusHistoryAsync(
        Guid id,
        CancellationToken cancellationToken)
    {
        await using var command = _dataSource.CreateCommand($"""
            select 1 from clients where id = @id;
            select {HistoryColumns} from client_status_history
            where client_id = @id order by changed_at desc, id desc;
            """);
        command.Parameters.Add(Uuid("id", id));

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            return null;
        }

        await reader.NextResultAsync(cancellationToken);

        var entries = new List<StatusHistoryEntry>();
        while (await reader.ReadAsync(cancellationToken))
        {
            entries.Add(ReadHistoryEntry(reader));
        }

        return entries;
    }

    /// <summary>
    /// Deletes a client and, by <c>on delete cascade</c>, its contacts. Takes no version: delete
    /// is the last word, and the UI's confirmation — which names the contact count — is the guard.
    /// </summary>
    public async Task<bool> DeleteAsync(Guid id, CancellationToken cancellationToken)
    {
        await using var command = _dataSource.CreateCommand("delete from clients where id = @id");
        command.Parameters.Add(Uuid("id", id));
        return await command.ExecuteNonQueryAsync(cancellationToken) > 0;
    }

    /// <summary>Adds a contact to a client.</summary>
    public async Task<MutationResult<ContactSummary>> AddContactAsync(
        Guid clientId,
        ContactFields fields,
        string actor,
        CancellationToken cancellationToken)
    {
        var conflict = await CheckContactAsync(clientId, fields.Email, excluding: null, cancellationToken);
        if (conflict is not null)
        {
            return conflict;
        }

        await using var command = _dataSource.CreateCommand($"""
            insert into contacts (id, client_id, full_name, email, role_title, notes, created_by, updated_by)
            select @id, @clientId, @fullName, @email, @roleTitle, @notes, @actor, @actor
            where exists (select 1 from clients where id = @clientId)
            returning {ContactColumns};
            """);
        command.Parameters.Add(Uuid("id", Guid.CreateVersion7()));
        command.Parameters.Add(Uuid("clientId", clientId));
        command.Parameters.Add(Text("fullName", fields.FullName));
        command.Parameters.Add(Text("email", fields.Email));
        command.Parameters.Add(Text("roleTitle", fields.RoleTitle));
        command.Parameters.Add(Text("notes", fields.Notes));
        command.Parameters.Add(Text("actor", actor));

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);

        // `insert … select … where exists` inserts nothing when the client is gone, which is the
        // same answer as never having found it — and it closes the window between the check above
        // and this statement without a transaction.
        return await reader.ReadAsync(cancellationToken)
            ? MutationResult<ContactSummary>.Applied(ReadContact(reader))
            : MutationResult<ContactSummary>.NotFound();
    }

    /// <summary>
    /// Replaces a contact's mutable fields, guarded by <paramref name="expectedVersion"/>. Scoped
    /// by <paramref name="clientId"/> as well as the contact id, so a contact id from one client
    /// cannot be edited through another client's route.
    /// </summary>
    public async Task<MutationResult<ContactSummary>> UpdateContactAsync(
        Guid clientId,
        Guid contactId,
        ContactFields fields,
        long expectedVersion,
        string actor,
        CancellationToken cancellationToken)
    {
        var conflict = await CheckContactAsync(clientId, fields.Email, excluding: contactId, cancellationToken);
        if (conflict is not null)
        {
            // A sibling holding this email says nothing about whether the contact being edited
            // exists. Reporting 409 for an id that was never there would send the user off to
            // reload a row that is gone, so confirm it first — one extra query, and only on the
            // already-rare conflict path.
            return await ContactExistsAsync(clientId, contactId, cancellationToken)
                ? conflict
                : MutationResult<ContactSummary>.NotFound();
        }

        await using var command = _dataSource.CreateCommand($"""
            update contacts
            set full_name = @fullName, email = @email, role_title = @roleTitle, notes = @notes,
                version = version + 1, updated_at = now(), updated_by = @actor
            where id = @id and client_id = @clientId and version = @expected
            returning {ContactColumns};
            """);
        command.Parameters.Add(Uuid("id", contactId));
        command.Parameters.Add(Uuid("clientId", clientId));
        command.Parameters.Add(Text("fullName", fields.FullName));
        command.Parameters.Add(Text("email", fields.Email));
        command.Parameters.Add(Text("roleTitle", fields.RoleTitle));
        command.Parameters.Add(Text("notes", fields.Notes));
        command.Parameters.Add(Text("actor", actor));
        command.Parameters.Add(BigInt("expected", expectedVersion));

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (await reader.ReadAsync(cancellationToken))
        {
            return MutationResult<ContactSummary>.Applied(ReadContact(reader));
        }

        await reader.CloseAsync();
        return await ContactExistsAsync(clientId, contactId, cancellationToken)
            ? MutationResult<ContactSummary>.VersionConflict()
            : MutationResult<ContactSummary>.NotFound();
    }

    public async Task<bool> DeleteContactAsync(Guid clientId, Guid contactId, CancellationToken cancellationToken)
    {
        await using var command = _dataSource.CreateCommand(
            "delete from contacts where id = @id and client_id = @clientId");
        command.Parameters.Add(Uuid("id", contactId));
        command.Parameters.Add(Uuid("clientId", clientId));
        return await command.ExecuteNonQueryAsync(cancellationToken) > 0;
    }

    /// <summary>
    /// Every interaction logged against a client, newest first, or null when no such client
    /// exists — so the endpoint can 404 rather than serve an empty log for a deleted id.
    /// </summary>
    /// <remarks>
    /// <b>Unpaged on purpose, unlike <see cref="ListAsync"/>.</b> Both child collections on a
    /// client's page — this log and its contacts — are read whole, because the page shows them
    /// whole and a pager over five rows is worse than no pager. The asymmetry is recorded rather
    /// than left implicit because an interaction log is the one table here that only ever grows:
    /// contacts stay in single digits, touches accumulate forever. Paging both is the fix when a
    /// real client's history stops fitting a screen — the same shape of deferral as pg_trgm for
    /// search, and for the same reason (the index already covers the read; what gives out first
    /// is the payload, not the scan). Deliberately not done at ~200 clients with a handful of
    /// touches each.
    /// </remarks>
    public async Task<IReadOnlyList<InteractionSummary>?> ListInteractionsAsync(
        Guid clientId,
        CancellationToken cancellationToken)
    {
        await using var command = _dataSource.CreateCommand($"""
            select 1 from clients where id = @clientId;
            select {InteractionColumns} from interactions
            where client_id = @clientId order by occurred_on desc, created_at desc, id desc;
            """);
        command.Parameters.Add(Uuid("clientId", clientId));

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            return null;
        }

        await reader.NextResultAsync(cancellationToken);

        var interactions = new List<InteractionSummary>();
        while (await reader.ReadAsync(cancellationToken))
        {
            interactions.Add(ReadInteraction(reader));
        }

        return interactions;
    }

    /// <summary>Logs an interaction against a client.</summary>
    public async Task<MutationResult<InteractionSummary>> AddInteractionAsync(
        Guid clientId,
        InteractionFields fields,
        string actor,
        CancellationToken cancellationToken)
    {
        // Same shape as AddContactAsync, with one more guard: a supplied contact must belong to
        // THIS client, or the log would quietly link a touch to somebody else's person.
        await using var command = _dataSource.CreateCommand($"""
            insert into interactions (id, client_id, contact_id, kind, occurred_on, summary,
                                      follow_up_on, created_by, updated_by)
            select @id, @clientId, @contactId, @kind, @occurredOn, @summary, @followUpOn, @actor, @actor
            where exists (select 1 from clients where id = @clientId)
              and (@contactId::uuid is null
                   or exists (select 1 from contacts where id = @contactId and client_id = @clientId))
            returning {InteractionColumns};
            """);
        command.Parameters.Add(Uuid("id", Guid.CreateVersion7()));
        command.Parameters.Add(Uuid("clientId", clientId));
        command.Parameters.Add(NullableUuid("contactId", fields.ContactId));
        command.Parameters.Add(Text("kind", fields.Kind));
        command.Parameters.Add(Date("occurredOn", fields.OccurredOn));
        command.Parameters.Add(Text("summary", fields.Summary));
        command.Parameters.Add(NullableDate("followUpOn", fields.FollowUpOn));
        command.Parameters.Add(Text("actor", actor));

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (await reader.ReadAsync(cancellationToken))
        {
            return MutationResult<InteractionSummary>.Applied(ReadInteraction(reader));
        }

        // Zero rows: either the client is gone, or it's there and the contact reference is bad.
        await reader.CloseAsync();
        return await ClientExistsAsync(clientId, cancellationToken)
            ? MutationResult<InteractionSummary>.InvalidReference(
                "That contact doesn't belong to this client (or no longer exists).")
            : MutationResult<InteractionSummary>.NotFound();
    }

    /// <summary>
    /// Replaces an interaction's mutable fields, guarded by <paramref name="expectedVersion"/>.
    /// Scoped by <paramref name="clientId"/> like the contact routes.
    /// </summary>
    public async Task<MutationResult<InteractionSummary>> UpdateInteractionAsync(
        Guid clientId,
        Guid interactionId,
        InteractionFields fields,
        long expectedVersion,
        string actor,
        CancellationToken cancellationToken)
    {
        await using var command = _dataSource.CreateCommand($"""
            update interactions
            set kind = @kind, occurred_on = @occurredOn, summary = @summary,
                follow_up_on = @followUpOn, contact_id = @contactId,
                version = version + 1, updated_at = now(), updated_by = @actor
            where id = @id and client_id = @clientId and version = @expected
              and (@contactId::uuid is null
                   or exists (select 1 from contacts where id = @contactId and client_id = @clientId))
            returning {InteractionColumns};
            """);
        command.Parameters.Add(Uuid("id", interactionId));
        command.Parameters.Add(Uuid("clientId", clientId));
        command.Parameters.Add(NullableUuid("contactId", fields.ContactId));
        command.Parameters.Add(Text("kind", fields.Kind));
        command.Parameters.Add(Date("occurredOn", fields.OccurredOn));
        command.Parameters.Add(Text("summary", fields.Summary));
        command.Parameters.Add(NullableDate("followUpOn", fields.FollowUpOn));
        command.Parameters.Add(Text("actor", actor));
        command.Parameters.Add(BigInt("expected", expectedVersion));

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (await reader.ReadAsync(cancellationToken))
        {
            return MutationResult<InteractionSummary>.Applied(ReadInteraction(reader));
        }

        // Three possible reasons for zero rows, told apart in order of honesty: a missing row is
        // 404 whatever else is true; then a bad contact reference must not masquerade as a
        // version conflict, or the user reloads forever chasing a 409 that isn't one.
        await reader.CloseAsync();
        if (!await InteractionExistsAsync(clientId, interactionId, cancellationToken))
        {
            return MutationResult<InteractionSummary>.NotFound();
        }

        if (fields.ContactId is { } contactId
            && !await ContactExistsAsync(clientId, contactId, cancellationToken))
        {
            return MutationResult<InteractionSummary>.InvalidReference(
                "That contact doesn't belong to this client (or no longer exists).");
        }

        return MutationResult<InteractionSummary>.VersionConflict();
    }

    public async Task<bool> DeleteInteractionAsync(
        Guid clientId,
        Guid interactionId,
        CancellationToken cancellationToken)
    {
        await using var command = _dataSource.CreateCommand(
            "delete from interactions where id = @id and client_id = @clientId");
        command.Parameters.Add(Uuid("id", interactionId));
        command.Parameters.Add(Uuid("clientId", clientId));
        return await command.ExecuteNonQueryAsync(cancellationToken) > 0;
    }

    /// <summary>
    /// Looks for an existing contact of this client with the same email, so the answer can name
    /// it. Returns null when there is no clash.
    /// </summary>
    /// <remarks>
    /// This is a check-then-write, so it races. <c>contacts_client_email_uniq</c> is what
    /// actually enforces the rule, and <c>DatabaseGateFilter</c> turns the loser of that race
    /// into the same 409 — this exists only to make the common case's message useful.
    /// </remarks>
    private async Task<MutationResult<ContactSummary>?> CheckContactAsync(
        Guid clientId,
        string? email,
        Guid? excluding,
        CancellationToken cancellationToken)
    {
        if (email is null)
        {
            return null;
        }

        await using var command = _dataSource.CreateCommand("""
            select full_name, email from contacts
            where client_id = @clientId and lower(email) = lower(@email) and (@excluding::uuid is null or id <> @excluding)
            limit 1
            """);
        command.Parameters.Add(Uuid("clientId", clientId));
        command.Parameters.Add(Text("email", email));
        command.Parameters.Add(NullableUuid("excluding", excluding));

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            return null;
        }

        var name = NullableString(reader, 0);
        var existing = NullableString(reader, 1) ?? email;

        return MutationResult<ContactSummary>.Duplicate(
            name is null
                ? $"This client already has a contact with the email {existing}."
                : $"This client already has a contact with the email {existing} ({name}).");
    }

    private async Task<bool> ClientExistsAsync(Guid id, CancellationToken cancellationToken)
    {
        await using var command = _dataSource.CreateCommand("select 1 from clients where id = @id");
        command.Parameters.Add(Uuid("id", id));
        return await command.ExecuteScalarAsync(cancellationToken) is not null;
    }

    private async Task<bool> ContactExistsAsync(Guid clientId, Guid contactId, CancellationToken cancellationToken)
    {
        await using var command = _dataSource.CreateCommand(
            "select 1 from contacts where id = @id and client_id = @clientId");
        command.Parameters.Add(Uuid("id", contactId));
        command.Parameters.Add(Uuid("clientId", clientId));
        return await command.ExecuteScalarAsync(cancellationToken) is not null;
    }

    private async Task<bool> InteractionExistsAsync(
        Guid clientId,
        Guid interactionId,
        CancellationToken cancellationToken)
    {
        await using var command = _dataSource.CreateCommand(
            "select 1 from interactions where id = @id and client_id = @clientId");
        command.Parameters.Add(Uuid("id", interactionId));
        command.Parameters.Add(Uuid("clientId", clientId));
        return await command.ExecuteScalarAsync(cancellationToken) is not null;
    }

    private static ClientDetail ReadClient(NpgsqlDataReader reader) => new(
        Id: reader.GetGuid(0),
        Name: reader.GetString(1),
        Industry: NullableString(reader, 2),
        Location: NullableString(reader, 3),
        Website: NullableString(reader, 4),
        WhatTheyDo: NullableString(reader, 5),
        Notes: NullableString(reader, 6),
        Status: reader.GetString(7),
        AcquiredAt: NullableDate(reader, 8),
        Source: NullableString(reader, 9),
        Owner: NullableString(reader, 10),
        LostReason: NullableString(reader, 11),
        Contacts: [],
        Version: reader.GetInt64(12),
        CreatedAt: reader.GetFieldValue<DateTimeOffset>(13),
        CreatedBy: reader.GetString(14),
        UpdatedAt: reader.GetFieldValue<DateTimeOffset>(15),
        UpdatedBy: reader.GetString(16));

    private static ContactSummary ReadContact(NpgsqlDataReader reader) => new(
        Id: reader.GetGuid(0),
        FullName: NullableString(reader, 1),
        Email: NullableString(reader, 2),
        RoleTitle: NullableString(reader, 3),
        Notes: NullableString(reader, 4),
        Version: reader.GetInt64(5),
        UpdatedAt: reader.GetFieldValue<DateTimeOffset>(6));

    private static InteractionSummary ReadInteraction(NpgsqlDataReader reader) => new(
        Id: reader.GetGuid(0),
        ContactId: reader.IsDBNull(1) ? null : reader.GetGuid(1),
        Kind: reader.GetString(2),
        OccurredOn: reader.GetFieldValue<DateOnly>(3),
        Summary: reader.GetString(4),
        FollowUpOn: NullableDate(reader, 5),
        Version: reader.GetInt64(6),
        CreatedAt: reader.GetFieldValue<DateTimeOffset>(7),
        CreatedBy: reader.GetString(8),
        UpdatedAt: reader.GetFieldValue<DateTimeOffset>(9));

    private static StatusHistoryEntry ReadHistoryEntry(NpgsqlDataReader reader) => new(
        Id: reader.GetGuid(0),
        FromStatus: reader.GetString(1),
        ToStatus: reader.GetString(2),
        ChangedAt: reader.GetFieldValue<DateTimeOffset>(3),
        ChangedBy: reader.GetString(4));

    private static async Task<IReadOnlyList<ContactSummary>> ReadContactsAsync(
        NpgsqlDataReader reader,
        CancellationToken cancellationToken)
    {
        var contacts = new List<ContactSummary>();
        while (await reader.ReadAsync(cancellationToken))
        {
            contacts.Add(ReadContact(reader));
        }

        return contacts;
    }

    private static string? NullableString(NpgsqlDataReader reader, int ordinal) =>
        reader.IsDBNull(ordinal) ? null : reader.GetString(ordinal);

    private static DateOnly? NullableDate(NpgsqlDataReader reader, int ordinal) =>
        reader.IsDBNull(ordinal) ? null : reader.GetFieldValue<DateOnly>(ordinal);

    // Parameters carry an explicit type rather than relying on inference, because a null value
    // gives Npgsql nothing to infer from.
    private static NpgsqlParameter Text(string name, string? value) =>
        new(name, NpgsqlDbType.Text) { Value = (object?)value ?? DBNull.Value };

    private static NpgsqlParameter Date(string name, DateOnly value) =>
        new(name, NpgsqlDbType.Date) { Value = value };

    private static NpgsqlParameter NullableDate(string name, DateOnly? value) =>
        new(name, NpgsqlDbType.Date) { Value = (object?)value ?? DBNull.Value };

    private static NpgsqlParameter Uuid(string name, Guid value) =>
        new(name, NpgsqlDbType.Uuid) { Value = value };

    private static NpgsqlParameter NullableUuid(string name, Guid? value) =>
        new(name, NpgsqlDbType.Uuid) { Value = (object?)value ?? DBNull.Value };

    private static NpgsqlParameter BigInt(string name, long value) =>
        new(name, NpgsqlDbType.Bigint) { Value = value };

    private static NpgsqlParameter Int(string name, int value) =>
        new(name, NpgsqlDbType.Integer) { Value = value };
}
