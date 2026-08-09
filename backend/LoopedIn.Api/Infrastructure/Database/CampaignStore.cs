using LoopedIn.Api.Models;
using Npgsql;
using NpgsqlTypes;

namespace LoopedIn.Api.Infrastructure.Database;

/// <summary>
/// Every SQL statement behind <c>/campaigns</c>, in one place, fully parameterized.
/// </summary>
/// <remarks>
/// Concrete rather than behind an interface, and registered only when <c>DATABASE_URL</c> is
/// set, for the reasons <see cref="ClientStore"/> records — this class follows its shapes
/// throughout, including the zero-rows disambiguation and the close-before-disambiguate rule.
/// </remarks>
public sealed class CampaignStore
{
    /// <summary>
    /// The search predicate, shared by the page query and the count that backs up the windowed
    /// total. Name only: a campaign's searchable identity is its name — the brief is prose.
    /// </summary>
    private const string ListFilter = """
        (@pattern::text is null or c.name ilike @pattern escape '\')
        """;

    // Each of these column lists is coupled by position to its reader (ReadCampaign,
    // ReadMessage, ReadOption) — add a column and you renumber the ordinals in the same change,
    // or the mismatch surfaces as an InvalidCastException at runtime.
    private const string CampaignColumns =
        "id, name, brief, version, created_at, created_by, updated_at, updated_by";

    private const string MessageJoinColumns =
        "m.id, m.client_id, cl.name, m.contact_id, ct.full_name, m.subject, m.body, m.state, "
        + "m.sent_at, m.version, m.created_at, m.created_by, m.updated_at, m.updated_by";

    /// <summary>
    /// The joins that turn a <c>campaign_messages</c> row (aliased <c>m</c>) into the
    /// display-ready <see cref="CampaignMessage"/> shape.
    /// </summary>
    private const string MessageJoins =
        "join clients cl on cl.id = m.client_id left join contacts ct on ct.id = m.contact_id";

    private const string OptionColumns = "ct.client_id, ct.id, ct.full_name, ct.email";

    private readonly NpgsqlDataSource _dataSource;

    public CampaignStore(NpgsqlDataSource dataSource)
    {
        _dataSource = dataSource;
    }

    /// <summary>
    /// One page of campaigns, newest first, each with its derived per-state message counts.
    /// </summary>
    /// <remarks>
    /// The counts come from one <c>left join lateral</c> rather than five correlated scalar
    /// subqueries, so each campaign row costs one index scan of its messages, not five. An
    /// aggregate-only subquery always yields exactly one row, so the lateral join always
    /// matches and the counts are never null. The count columns are a de-facto mirror of
    /// <c>campaign_messages_state_allowed</c> — extending the state list means extending this
    /// query and <see cref="CampaignSummary"/> with it.
    /// </remarks>
    public async Task<CampaignListResponse> ListAsync(
        string? searchPattern,
        int limit,
        int offset,
        CancellationToken cancellationToken)
    {
        var campaigns = new List<CampaignSummary>();
        var total = 0;

        await using (var command = _dataSource.CreateCommand($"""
            select c.id, c.name, c.version, c.updated_at,
                   m.total, m.drafted, m.approved, m.sent, m.skipped,
                   count(*) over () as total_count
            from campaigns c
            left join lateral (
                select count(*) as total,
                       count(*) filter (where state = 'drafted')  as drafted,
                       count(*) filter (where state = 'approved') as approved,
                       count(*) filter (where state = 'sent')     as sent,
                       count(*) filter (where state = 'skipped')  as skipped
                from campaign_messages where campaign_id = c.id
            ) m on true
            where {ListFilter}
            order by c.created_at desc, c.id desc
            limit @limit offset @offset
            """))
        {
            command.Parameters.Add(Text("pattern", searchPattern));
            command.Parameters.Add(Int("limit", limit));
            command.Parameters.Add(Int("offset", offset));

            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                campaigns.Add(new CampaignSummary(
                    Id: reader.GetGuid(0),
                    Name: reader.GetString(1),
                    MessageCount: (int)reader.GetInt64(4),
                    DraftedCount: (int)reader.GetInt64(5),
                    ApprovedCount: (int)reader.GetInt64(6),
                    SentCount: (int)reader.GetInt64(7),
                    SkippedCount: (int)reader.GetInt64(8),
                    Version: reader.GetInt64(2),
                    UpdatedAt: reader.GetFieldValue<DateTimeOffset>(3)));

                total = (int)reader.GetInt64(9);
            }
        }

        // Same fallback as ClientStore.ListAsync: an offset past the end returns no rows and
        // therefore no windowed total.
        if (campaigns.Count == 0 && offset > 0)
        {
            total = await CountAsync(searchPattern, cancellationToken);
        }

        return new CampaignListResponse(campaigns, total, limit, offset);
    }

    private async Task<int> CountAsync(string? searchPattern, CancellationToken cancellationToken)
    {
        await using var command = _dataSource.CreateCommand($"""
            select count(*) from campaigns c where {ListFilter}
            """);
        command.Parameters.Add(Text("pattern", searchPattern));

        return (int)(long)(await command.ExecuteScalarAsync(cancellationToken) ?? 0L);
    }

    /// <summary>
    /// One campaign with its messages and recipient options, or null when no such campaign
    /// exists.
    /// </summary>
    /// <remarks>
    /// Messages are read whole, unpaged, like a client's contacts — the page shows them whole.
    /// The payload grows with the campaign (worst case ~150 messages × 10k bodies); paging is
    /// the fix when a real campaign stops fitting a screen, the same deferral shape as
    /// <c>pg_trgm</c> for search. The third statement gathers the recipient options: contacts
    /// of every client that already has a message here — see <see cref="CampaignContactOption"/>.
    /// </remarks>
    public async Task<CampaignDetail?> FindAsync(Guid id, CancellationToken cancellationToken)
    {
        await using var command = _dataSource.CreateCommand($"""
            select {CampaignColumns} from campaigns where id = @id;
            select {MessageJoinColumns} from campaign_messages m {MessageJoins}
            where m.campaign_id = @id order by m.created_at, m.id;
            select {OptionColumns} from contacts ct
            where ct.client_id in (select client_id from campaign_messages where campaign_id = @id)
            order by ct.client_id, ct.created_at, ct.id;
            """);
        command.Parameters.Add(Uuid("id", id));

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            return null;
        }

        var campaign = ReadCampaign(reader);
        await reader.NextResultAsync(cancellationToken);
        var messages = await ReadMessagesAsync(reader, cancellationToken);
        await reader.NextResultAsync(cancellationToken);
        var options = await ReadOptionsAsync(reader, cancellationToken);

        return campaign with { Messages = messages, ContactOptions = options };
    }

    /// <summary>Creates a campaign. It starts with no messages.</summary>
    public async Task<CampaignDetail> CreateAsync(
        CampaignFields fields,
        string actor,
        CancellationToken cancellationToken)
    {
        await using var command = _dataSource.CreateCommand($"""
            insert into campaigns (id, name, brief, created_by, updated_by)
            values (@id, @name, @brief, @actor, @actor)
            returning {CampaignColumns};
            """);
        command.Parameters.Add(Uuid("id", Guid.CreateVersion7()));
        command.Parameters.Add(Text("name", fields.Name));
        command.Parameters.Add(Text("brief", fields.Brief));
        command.Parameters.Add(Text("actor", actor));

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        await reader.ReadAsync(cancellationToken);
        return ReadCampaign(reader);
    }

    /// <summary>
    /// Replaces a campaign's mutable fields, guarded by <paramref name="expectedVersion"/>.
    /// </summary>
    public async Task<MutationResult<CampaignDetail>> UpdateAsync(
        Guid id,
        CampaignFields fields,
        long expectedVersion,
        string actor,
        CancellationToken cancellationToken)
    {
        CampaignDetail campaign;
        IReadOnlyList<CampaignMessage> messages;
        IReadOnlyList<CampaignContactOption> options;

        await using (var command = _dataSource.CreateCommand($"""
            update campaigns
            set name = @name, brief = @brief,
                version = version + 1, updated_at = now(), updated_by = @actor
            where id = @id and version = @expected
            returning {CampaignColumns};
            select {MessageJoinColumns} from campaign_messages m {MessageJoins}
            where m.campaign_id = @id order by m.created_at, m.id;
            select {OptionColumns} from contacts ct
            where ct.client_id in (select client_id from campaign_messages where campaign_id = @id)
            order by ct.client_id, ct.created_at, ct.id;
            """))
        {
            command.Parameters.Add(Uuid("id", id));
            command.Parameters.Add(Text("name", fields.Name));
            command.Parameters.Add(Text("brief", fields.Brief));
            command.Parameters.Add(Text("actor", actor));
            command.Parameters.Add(BigInt("expected", expectedVersion));

            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            if (!await reader.ReadAsync(cancellationToken))
            {
                // Closed before the disambiguation for the reason ClientStore.UpdateAsync
                // records: one pooled connection at a time on the contended path.
                await reader.CloseAsync();
                return await CampaignExistsAsync(id, cancellationToken)
                    ? MutationResult<CampaignDetail>.VersionConflict()
                    : MutationResult<CampaignDetail>.NotFound();
            }

            campaign = ReadCampaign(reader);
            await reader.NextResultAsync(cancellationToken);
            messages = await ReadMessagesAsync(reader, cancellationToken);
            await reader.NextResultAsync(cancellationToken);
            options = await ReadOptionsAsync(reader, cancellationToken);
        }

        return MutationResult<CampaignDetail>.Applied(
            campaign with { Messages = messages, ContactOptions = options });
    }

    /// <summary>
    /// Deletes a campaign and, by <c>on delete cascade</c>, its messages. Takes no version:
    /// delete is the last word, and the UI's confirmation names the message count.
    /// </summary>
    public async Task<bool> DeleteAsync(Guid id, CancellationToken cancellationToken)
    {
        await using var command = _dataSource.CreateCommand("delete from campaigns where id = @id");
        command.Parameters.Add(Uuid("id", id));
        return await command.ExecuteNonQueryAsync(cancellationToken) > 0;
    }

    /// <summary>
    /// Drafts a message into a campaign. The row starts as <c>drafted</c> via the column
    /// default; a duplicate (campaign, client) pair surfaces as a unique violation, which
    /// <c>DatabaseGateFilter</c> turns into the specific 409 — deliberately no pre-check here,
    /// because the constraint expresses exactly one rule and the filter's message already
    /// names the fix.
    /// </summary>
    public async Task<MutationResult<CampaignMessage>> AddMessageAsync(
        Guid campaignId,
        Guid clientId,
        CampaignMessageFields fields,
        string actor,
        CancellationToken cancellationToken)
    {
        // Same insert-where-exists shape as AddInteractionAsync: zero rows when the campaign or
        // client is gone, or when the contact isn't this client's — no transaction needed.
        await using var command = _dataSource.CreateCommand($"""
            with inserted as (
                insert into campaign_messages (id, campaign_id, client_id, contact_id, subject,
                                               body, created_by, updated_by)
                select @id, @campaignId, @clientId, @contactId, @subject, @body, @actor, @actor
                where exists (select 1 from campaigns where id = @campaignId)
                  and exists (select 1 from clients where id = @clientId)
                  and (@contactId::uuid is null
                       or exists (select 1 from contacts
                                  where id = @contactId and client_id = @clientId))
                returning *
            )
            select {MessageJoinColumns} from inserted m {MessageJoins};
            """);
        command.Parameters.Add(Uuid("id", Guid.CreateVersion7()));
        command.Parameters.Add(Uuid("campaignId", campaignId));
        command.Parameters.Add(Uuid("clientId", clientId));
        command.Parameters.Add(NullableUuid("contactId", fields.ContactId));
        command.Parameters.Add(Text("subject", fields.Subject));
        command.Parameters.Add(Text("body", fields.Body));
        command.Parameters.Add(Text("actor", actor));

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (await reader.ReadAsync(cancellationToken))
        {
            return MutationResult<CampaignMessage>.Applied(ReadMessage(reader));
        }

        // Three possible reasons for zero rows: the campaign is gone (404 — it is the route's
        // subject), the client reference is bad, or the contact reference is.
        await reader.CloseAsync();
        if (!await CampaignExistsAsync(campaignId, cancellationToken))
        {
            return MutationResult<CampaignMessage>.NotFound();
        }

        return await ClientExistsAsync(clientId, cancellationToken)
            ? MutationResult<CampaignMessage>.InvalidReference(
                "That contact doesn't belong to this client (or no longer exists).")
            : MutationResult<CampaignMessage>.InvalidReference("That client no longer exists.");
    }

    /// <summary>
    /// Replaces a message's draft fields, guarded by <paramref name="expectedVersion"/>. Scoped
    /// by <paramref name="campaignId"/> like the contact routes, and deliberately unable to
    /// touch <c>state</c> or <c>sent_at</c> — <see cref="ChangeMessageStateAsync"/> is their
    /// only writer.
    /// </summary>
    public async Task<MutationResult<CampaignMessage>> UpdateMessageAsync(
        Guid campaignId,
        Guid messageId,
        CampaignMessageFields fields,
        long expectedVersion,
        string actor,
        CancellationToken cancellationToken)
    {
        // The contact guard references the row's own client_id: a recipient must be a contact
        // of the client the message is already for.
        await using var command = _dataSource.CreateCommand($"""
            with changed as (
                update campaign_messages
                set subject = @subject, body = @body, contact_id = @contactId,
                    version = version + 1, updated_at = now(), updated_by = @actor
                where id = @id and campaign_id = @campaignId and version = @expected
                  and (@contactId::uuid is null
                       or exists (select 1 from contacts ct
                                  where ct.id = @contactId
                                    and ct.client_id = campaign_messages.client_id))
                returning *
            )
            select {MessageJoinColumns} from changed m {MessageJoins};
            """);
        command.Parameters.Add(Uuid("id", messageId));
        command.Parameters.Add(Uuid("campaignId", campaignId));
        command.Parameters.Add(NullableUuid("contactId", fields.ContactId));
        command.Parameters.Add(Text("subject", fields.Subject));
        command.Parameters.Add(Text("body", fields.Body));
        command.Parameters.Add(Text("actor", actor));
        command.Parameters.Add(BigInt("expected", expectedVersion));

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (await reader.ReadAsync(cancellationToken))
        {
            return MutationResult<CampaignMessage>.Applied(ReadMessage(reader));
        }

        // Told apart in UpdateInteractionAsync's order of honesty: a missing row is 404
        // whatever else is true; then a bad recipient must not masquerade as a 409.
        await reader.CloseAsync();
        if (!await MessageExistsAsync(campaignId, messageId, cancellationToken))
        {
            return MutationResult<CampaignMessage>.NotFound();
        }

        if (fields.ContactId is { } contactId
            && !await ContactOfMessageClientExistsAsync(campaignId, messageId, contactId, cancellationToken))
        {
            return MutationResult<CampaignMessage>.InvalidReference(
                "That contact doesn't belong to this client (or no longer exists).");
        }

        return MutationResult<CampaignMessage>.VersionConflict();
    }

    /// <summary>
    /// Moves a message to a new state, guarded by <paramref name="expectedVersion"/>. The only
    /// writer of <c>state</c> and <c>sent_at</c>, and the writer of the <c>email</c>
    /// interaction that records a send.
    /// </summary>
    /// <remarks>
    /// Transitions are free — any state to any state, same-state included, mirroring
    /// <c>lost → lost</c> on clients — but entering <c>sent</c> has three side effects:
    /// <c>sent_at</c> is stamped (coalesced, so a repeated <c>sent</c> keeps the original), an
    /// <c>email</c> interaction is appended to the client's outreach log, and leaving
    /// <c>sent</c> later clears <c>sent_at</c> again (a "drafted, sent at …" row would lie).
    /// The interaction append is gated on the <em>pre-update</em> state, so <c>sent → sent</c>
    /// never fabricates a second touch; a genuine re-send (leave and re-enter) correctly logs
    /// one. A mis-recorded send is retracted by moving off <c>sent</c> and deleting the
    /// interaction — interactions are ordinary CRUD, unlike <c>client_status_history</c>.
    /// </remarks>
    public async Task<MutationResult<CampaignMessage>> ChangeMessageStateAsync(
        Guid campaignId,
        Guid messageId,
        string state,
        long expectedVersion,
        string actor,
        CancellationToken cancellationToken)
    {
        // Same CTE-chain shape as ClientStore.ChangeStatusAsync, and the same two Postgres
        // behaviours carry it: every CTE reads one snapshot (`prev` sees the pre-update state),
        // and a data-modifying CTE runs even when nothing selects from it — `recorded` is NOT
        // dead code. The insert selects from `changed`, so a version conflict writes nothing.
        // left(…, 2000) is free insurance for the interactions summary CHECK — name and subject
        // caps put the composed string well under it. occurred_on is current_date, UTC on Neon,
        // the caveat 0002 records for acquired_at.
        await using var command = _dataSource.CreateCommand($"""
            with prev as (
                select state as prev_state from campaign_messages
                where id = @id and campaign_id = @campaignId
            ),
            changed as (
                update campaign_messages
                set state   = @state,
                    sent_at = case when @state = 'sent'
                                   then coalesce(sent_at, now())
                                   else null end,
                    version = version + 1, updated_at = now(), updated_by = @actor
                where id = @id and campaign_id = @campaignId and version = @expected
                returning *
            ),
            recorded as (
                insert into interactions (id, client_id, contact_id, kind, occurred_on, summary,
                                          created_by, updated_by)
                select @interactionId, m.client_id, m.contact_id, 'email', current_date,
                       left('Campaign email sent — ' || c.name || ': ' || m.subject, 2000),
                       @actor, @actor
                from changed m
                cross join prev p
                join campaigns c on c.id = m.campaign_id
                where @state = 'sent' and p.prev_state <> 'sent'
            )
            select {MessageJoinColumns} from changed m {MessageJoins};
            """);
        command.Parameters.Add(Uuid("id", messageId));
        command.Parameters.Add(Uuid("campaignId", campaignId));
        command.Parameters.Add(Text("state", state));
        command.Parameters.Add(Text("actor", actor));
        command.Parameters.Add(BigInt("expected", expectedVersion));
        command.Parameters.Add(Uuid("interactionId", Guid.CreateVersion7()));

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (await reader.ReadAsync(cancellationToken))
        {
            return MutationResult<CampaignMessage>.Applied(ReadMessage(reader));
        }

        await reader.CloseAsync();
        return await MessageExistsAsync(campaignId, messageId, cancellationToken)
            ? MutationResult<CampaignMessage>.VersionConflict()
            : MutationResult<CampaignMessage>.NotFound();
    }

    public async Task<bool> DeleteMessageAsync(
        Guid campaignId,
        Guid messageId,
        CancellationToken cancellationToken)
    {
        await using var command = _dataSource.CreateCommand(
            "delete from campaign_messages where id = @id and campaign_id = @campaignId");
        command.Parameters.Add(Uuid("id", messageId));
        command.Parameters.Add(Uuid("campaignId", campaignId));
        return await command.ExecuteNonQueryAsync(cancellationToken) > 0;
    }

    private async Task<bool> CampaignExistsAsync(Guid id, CancellationToken cancellationToken)
    {
        await using var command = _dataSource.CreateCommand("select 1 from campaigns where id = @id");
        command.Parameters.Add(Uuid("id", id));
        return await command.ExecuteScalarAsync(cancellationToken) is not null;
    }

    private async Task<bool> ClientExistsAsync(Guid id, CancellationToken cancellationToken)
    {
        await using var command = _dataSource.CreateCommand("select 1 from clients where id = @id");
        command.Parameters.Add(Uuid("id", id));
        return await command.ExecuteScalarAsync(cancellationToken) is not null;
    }

    private async Task<bool> MessageExistsAsync(
        Guid campaignId,
        Guid messageId,
        CancellationToken cancellationToken)
    {
        await using var command = _dataSource.CreateCommand(
            "select 1 from campaign_messages where id = @id and campaign_id = @campaignId");
        command.Parameters.Add(Uuid("id", messageId));
        command.Parameters.Add(Uuid("campaignId", campaignId));
        return await command.ExecuteScalarAsync(cancellationToken) is not null;
    }

    private async Task<bool> ContactOfMessageClientExistsAsync(
        Guid campaignId,
        Guid messageId,
        Guid contactId,
        CancellationToken cancellationToken)
    {
        await using var command = _dataSource.CreateCommand("""
            select 1 from contacts ct
            join campaign_messages m on m.client_id = ct.client_id
            where m.id = @messageId and m.campaign_id = @campaignId and ct.id = @contactId
            """);
        command.Parameters.Add(Uuid("messageId", messageId));
        command.Parameters.Add(Uuid("campaignId", campaignId));
        command.Parameters.Add(Uuid("contactId", contactId));
        return await command.ExecuteScalarAsync(cancellationToken) is not null;
    }

    private static CampaignDetail ReadCampaign(NpgsqlDataReader reader) => new(
        Id: reader.GetGuid(0),
        Name: reader.GetString(1),
        Brief: NullableString(reader, 2),
        Messages: [],
        ContactOptions: [],
        Version: reader.GetInt64(3),
        CreatedAt: reader.GetFieldValue<DateTimeOffset>(4),
        CreatedBy: reader.GetString(5),
        UpdatedAt: reader.GetFieldValue<DateTimeOffset>(6),
        UpdatedBy: reader.GetString(7));

    private static CampaignMessage ReadMessage(NpgsqlDataReader reader) => new(
        Id: reader.GetGuid(0),
        ClientId: reader.GetGuid(1),
        ClientName: reader.GetString(2),
        ContactId: reader.IsDBNull(3) ? null : reader.GetGuid(3),
        ContactName: NullableString(reader, 4),
        Subject: reader.GetString(5),
        Body: reader.GetString(6),
        State: reader.GetString(7),
        SentAt: NullableTimestamp(reader, 8),
        Version: reader.GetInt64(9),
        CreatedAt: reader.GetFieldValue<DateTimeOffset>(10),
        CreatedBy: reader.GetString(11),
        UpdatedAt: reader.GetFieldValue<DateTimeOffset>(12),
        UpdatedBy: reader.GetString(13));

    private static CampaignContactOption ReadOption(NpgsqlDataReader reader) => new(
        ClientId: reader.GetGuid(0),
        Id: reader.GetGuid(1),
        FullName: NullableString(reader, 2),
        Email: NullableString(reader, 3));

    private static async Task<IReadOnlyList<CampaignMessage>> ReadMessagesAsync(
        NpgsqlDataReader reader,
        CancellationToken cancellationToken)
    {
        var messages = new List<CampaignMessage>();
        while (await reader.ReadAsync(cancellationToken))
        {
            messages.Add(ReadMessage(reader));
        }

        return messages;
    }

    private static async Task<IReadOnlyList<CampaignContactOption>> ReadOptionsAsync(
        NpgsqlDataReader reader,
        CancellationToken cancellationToken)
    {
        var options = new List<CampaignContactOption>();
        while (await reader.ReadAsync(cancellationToken))
        {
            options.Add(ReadOption(reader));
        }

        return options;
    }

    private static string? NullableString(NpgsqlDataReader reader, int ordinal) =>
        reader.IsDBNull(ordinal) ? null : reader.GetString(ordinal);

    private static DateTimeOffset? NullableTimestamp(NpgsqlDataReader reader, int ordinal) =>
        reader.IsDBNull(ordinal) ? null : reader.GetFieldValue<DateTimeOffset>(ordinal);

    // Parameters carry an explicit type rather than relying on inference, because a null value
    // gives Npgsql nothing to infer from.
    private static NpgsqlParameter Text(string name, string? value) =>
        new(name, NpgsqlDbType.Text) { Value = (object?)value ?? DBNull.Value };

    private static NpgsqlParameter Uuid(string name, Guid value) =>
        new(name, NpgsqlDbType.Uuid) { Value = value };

    private static NpgsqlParameter NullableUuid(string name, Guid? value) =>
        new(name, NpgsqlDbType.Uuid) { Value = (object?)value ?? DBNull.Value };

    private static NpgsqlParameter BigInt(string name, long value) =>
        new(name, NpgsqlDbType.Bigint) { Value = value };

    private static NpgsqlParameter Int(string name, int value) =>
        new(name, NpgsqlDbType.Integer) { Value = value };
}
