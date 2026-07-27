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
        """;

    private const string ClientColumns =
        "id, name, industry, location, notes, version, created_at, created_by, updated_at, updated_by";

    private const string ContactColumns = "id, full_name, email, role_title, notes, version, updated_at";

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
        int limit,
        int offset,
        CancellationToken cancellationToken)
    {
        var clients = new List<ClientSummary>();
        var total = 0;

        await using (var command = _dataSource.CreateCommand($"""
            select c.id, c.name, c.industry, c.location, c.version, c.updated_at,
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
                    ContactCount: (int)reader.GetInt64(6),
                    Version: reader.GetInt64(4),
                    UpdatedAt: reader.GetFieldValue<DateTimeOffset>(5)));

                total = (int)reader.GetInt64(7);
            }
        }

        // The windowed count rides on the rows, so an offset past the end returns no rows and
        // therefore no total — which would render as "0 of 0" over a database full of clients.
        // Only that case pays for a second query.
        if (clients.Count == 0 && offset > 0)
        {
            total = await CountAsync(searchPattern, industry, cancellationToken);
        }

        return new ClientListResponse(clients, total, limit, offset);
    }

    private async Task<int> CountAsync(string? searchPattern, string? industry, CancellationToken cancellationToken)
    {
        await using var command = _dataSource.CreateCommand($"""
            select count(*) from clients c where {ListFilter}
            """);
        command.Parameters.Add(Text("pattern", searchPattern));
        command.Parameters.Add(Text("industry", industry));

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

        await using var command = _dataSource.CreateCommand($"""
            select count(*) from clients where lower(name) = lower(@name);
            insert into clients (id, name, industry, location, notes, created_by, updated_by)
            values (@id, @name, @industry, @location, @notes, @actor, @actor)
            returning {ClientColumns};
            """);
        command.Parameters.Add(Uuid("id", id));
        command.Parameters.Add(Text("name", fields.Name));
        command.Parameters.Add(Text("industry", fields.Industry));
        command.Parameters.Add(Text("location", fields.Location));
        command.Parameters.Add(Text("notes", fields.Notes));
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

        await using (var command = _dataSource.CreateCommand($"""
            update clients
            set name = @name, industry = @industry, location = @location, notes = @notes,
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
            command.Parameters.Add(Text("notes", fields.Notes));
            command.Parameters.Add(Text("actor", actor));
            command.Parameters.Add(BigInt("expected", expectedVersion));

            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            if (!await reader.ReadAsync(cancellationToken))
            {
                // Zero rows means either "no such client" or "someone else got there first".
                // One extra query tells the two apart, and the caller needs to: a 404 and a 409
                // ask the user to do completely different things.
                return await ExistsAsync("clients", "id", id, cancellationToken)
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
            return conflict;
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

    private async Task<bool> ExistsAsync(string table, string column, Guid id, CancellationToken cancellationToken)
    {
        // table/column are compile-time constants from this file only — never request input.
        await using var command = _dataSource.CreateCommand($"select 1 from {table} where {column} = @id");
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

    private static ClientDetail ReadClient(NpgsqlDataReader reader) => new(
        Id: reader.GetGuid(0),
        Name: reader.GetString(1),
        Industry: NullableString(reader, 2),
        Location: NullableString(reader, 3),
        Notes: NullableString(reader, 4),
        Contacts: [],
        Version: reader.GetInt64(5),
        CreatedAt: reader.GetFieldValue<DateTimeOffset>(6),
        CreatedBy: reader.GetString(7),
        UpdatedAt: reader.GetFieldValue<DateTimeOffset>(8),
        UpdatedBy: reader.GetString(9));

    private static ContactSummary ReadContact(NpgsqlDataReader reader) => new(
        Id: reader.GetGuid(0),
        FullName: NullableString(reader, 1),
        Email: NullableString(reader, 2),
        RoleTitle: NullableString(reader, 3),
        Notes: NullableString(reader, 4),
        Version: reader.GetInt64(5),
        UpdatedAt: reader.GetFieldValue<DateTimeOffset>(6));

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
