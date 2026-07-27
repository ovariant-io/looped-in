# Plan — Client database (CRUD via web + API)

Branch: `feature/client-database` · Source data: `Datbase List – 27 July 2026.xlsx` (untracked, repo root)
Amended 2026-07-27 after review: locking, import determinism, version-based concurrency, the
sign-up gate, and the frozen import rules below all changed from the first draft.

**Goal:** a persistent client list in Neon Postgres, editable end-to-end — `/clients` in the web
app calling authenticated endpoints on the .NET API — seeded from the outreach spreadsheet with
nothing silently dropped.

This is the **first real SQL schema in the repo**. Documents deliberately have no table (S3 is the
whole source of truth), so there is no migration tooling, no ORM, and no data-access layer beyond
`NpgsqlDataSource` to inherit. Section 4 builds that foundation; it is the part that outlives this
feature — which is also why this plan writes down the *house patterns* it establishes (§3.2, §4,
§5, §10), not just the feature.

---

## 1. Decisions taken

| # | Decision | Chosen | Why |
| --- | --- | --- | --- |
| D1 | Schema shape | **`clients` + `contacts`** | 61 rows have a company but no person, 35 have neither a person nor an email, and several companies carry more than one person. A flat table can't hold either case honestly. |
| D2 | Tenancy | **Shared across all signed-in users** | It's one team's outreach list, not per-user filing. `created_by` / `updated_by` record who did what. Differs from documents on purpose — see §3.3, including the **sign-up gate this makes mandatory**. |
| D3 | Migrations | **Versioned SQL applied at startup** | Numbered `.sql` files + a `schema_migrations` table, applied idempotently under a **transaction-scoped advisory lock** (§4 — session locks break on Neon's pooled endpoint). No new dependency, works on Lambda, stays raw Npgsql. |
| D4 | Import | **Import everything, flag the bad rows** | ~20 cells are not what their column claims. Unparseable values land in `notes` and get reported; nothing is dropped and no typo is "fixed" by a script's guess. |
| D5 | Concurrency | **Integer `version` column, required on PATCH** | A timestamp comparison must round-trip Postgres microseconds through JSON and the browser bit-exactly — one pass through a JS `Date` truncates to milliseconds and every edit 409s. An integer compares exactly and becomes the house pattern for every future mutable table. |
| D6 | Import ids | **Deterministic UUIDv5, not UUIDv7** | The generated SQL is gitignored (it holds personal data), so *regeneration is the normal path* — and regenerated UUIDv7s are new ids, turning `on conflict do nothing` into a mass-duplication bug. UUIDv5 over a fixed namespace makes every run emit identical ids. v7's chronological ordering was worthless here anyway: all seeded rows share the apply-time `created_at`. |

---

## 2. What the data actually is

196 data rows, one sheet (`outreach - corporate`). Row 1 is a title banner, **row 2 is the header** —
and `A2` and `B2` are both labelled `Name` (A is the company, B the person).

| Col | Header | Filled | Distinct | Reality |
| --- | --- | --- | --- | --- |
| A | Name | 196 | 187 | Company. 6 companies appear twice; `Unknown` appears 4×. |
| B | Name | 135 | 135 | Person. 11 cells hold a role too (`«person», CEO`) or two people (`«name» and «name»`). |
| C | Email | 151 | 149 | 3 LinkedIn URLs, 2 multi-address cells, and 3 cells that aren't addresses at all — a status note (`submitted job application`), a `«name», «role»` string, an address with a space in its domain. |
| D | Role | 109 | 55 | Free text. `Managing Directo`, `Recriutment` — typos. |
| E | Location | 61 | 13 | Mixed grain: `Melbourne`, `SA`, `UK, USA`, `Cremorne, Melbourne`. |
| F | Industry | 176 | 27 | `Agency` (98) and `NFP` (30) dominate. `Goverment` and `Recriutment` are typos of existing values. |

(Real names and addresses are deliberately not quoted in this document — see the privacy note in
§7. Row numbers are given where a rule needs a concrete anchor; the spreadsheet is the reference.)

**Traps that shape the design:**

1. **`Unknown` × 4 must not merge into one client.** Deduping by name would silently fuse four
   unrelated prospects. The importer keeps a never-merge list.
2. **One company appears twice, with and without a leading `The`**, sharing a single email
   address — clearly the same firm, but no safe rule merges them. Imported as two, reported for a
   human merge.
3. **One organisation's generic inbox appears on two rows.** That is one contact recorded twice,
   and it is exactly what the `(client_id, lower(email))` unique index would reject — so the
   importer must dedupe contacts, not just clients.
4. **A company with no person is normal here** (35 rows have neither a person nor an email).
   `contacts` must be optional, which is the whole argument for D1.

---

## 3. Schema

### 3.1 DDL

```sql
create table if not exists clients (
    id          uuid        primary key,
    name        text        not null check (length(btrim(name)) between 1 and 200),
    industry    text        null check (industry is null or length(industry) <= 100),
    location    text        null check (location is null or length(location) <= 100),
    notes       text        null check (notes is null or length(notes) <= 4000),
    version     bigint      not null default 1,
    created_at  timestamptz not null default now(),
    created_by  text        not null,
    updated_at  timestamptz not null default now(),
    updated_by  text        not null
);

create index if not exists clients_name_lower_idx  on clients (lower(name));
create index if not exists clients_created_at_idx  on clients (created_at desc, id desc);

create table if not exists contacts (
    id          uuid        primary key,
    client_id   uuid        not null references clients (id) on delete cascade,
    full_name   text        null check (full_name is null or length(full_name) <= 200),
    email       text        null check (email is null or length(email) <= 320),
    role_title  text        null check (role_title is null or length(role_title) <= 200),
    notes       text        null check (notes is null or length(notes) <= 4000),
    version     bigint      not null default 1,
    created_at  timestamptz not null default now(),
    created_by  text        not null,
    updated_at  timestamptz not null default now(),
    updated_by  text        not null,
    constraint contacts_identifiable check (full_name is not null or email is not null)
);

create index if not exists contacts_client_idx on contacts (client_id, created_at);
create unique index if not exists contacts_client_email_uniq
    on contacts (client_id, lower(email)) where email is not null;
```

### 3.2 Choices worth stating

- **`text` + a `lower()` index, not `citext`.** `citext` needs `CREATE EXTENSION`, which is a
  privilege the app's Neon role may not have and a dependency the migration runner would have to
  handle. A functional index costs nothing and keeps the migration runnable by the app itself.
- **Email is unique *per client*, not globally.** Two people at different companies can share a
  shared inbox, and the data already proves the global constraint would fail.
- **No unique constraint on `clients.name`.** Real companies share names, `Unknown` appears four
  times, and a hard constraint would make the import fail rather than surface a duplicate. Create
  instead surfaces a soft "a client with this name already exists" warning from the API using the
  `lower(name)` index.
- **`on delete cascade`** — a contact has no meaning without its client. Deleting a client from the
  UI must say how many contacts go with it.
- **`version` is the optimistic-concurrency token** (D5): every UPDATE sets
  `version = version + 1` and carries `where version = @expected`. **This is the house pattern**:
  any future mutable table gets the same column, and `updated_at` is for display only — it never
  participates in a comparison, so it never needs to round-trip exactly.
- **Ids are UUIDv7 generated in C# with `Guid.CreateVersion7()`** for rows created through the
  API, matching how document ids are minted. Seeded rows use deterministic UUIDv5 instead (D6).
  Ordering queries sort by `(created_at desc, id desc)`, explicitly — never by id alone — so
  nothing depends on uuid byte order and paging has a stable tiebreak.
- **`created_by` / `updated_by` hold the Clerk `sub`**, taken from the validated token and never
  from the request body. Imported rows carry the sentinel `import:datbase-list-2026-07-27`, so
  seeded data stays distinguishable from user-entered data forever.

### 3.3 Tenancy — the deliberate divergence from documents

Documents are strictly per-user: the S3 key derives from the token's `sub`, so there is no request
shape that reaches another user's objects. **Clients are shared**: every signed-in user reads and
writes every row. That is the right model for one team's outreach list, but it means the isolation
guarantee documents get from the key layout does not exist here — authentication is the only gate.

**And "authentication" is only as narrow as sign-up.** Today the Clerk instance accepts
self-service sign-ups (and Dynamic Client Registration is enabled for the MCP server). Documents
leaked nothing cross-user under open registration; a shared table is the opposite — anyone who
creates an account reads the entire outreach list, which is the same personal data §7 keeps out of
git. **Restricting sign-up (Clerk Dashboard → Restrictions: invite-only or an allowlist) is
step 1 of the sequence and a hard precondition for step 7 (seeding real data).** It is not
optional hardening.

Two more consequences to hold onto:

- `.RequireAuthorization()` on every route is load-bearing, not decorative. There is no second
  line of defence.
- If Looped In ever has more than one customer organisation in one deployment, this table needs an
  `org_id` and every query needs a predicate. Adding the column later is a backfill; **retrofitting
  the predicate onto queries written without it is where tenancy bugs come from.** Deferred
  knowingly, recorded in §10.

---

## 4. Migration mechanism

New: `backend/LoopedIn.Api/Infrastructure/Database/Migrations/0001_clients_contacts.sql`, embedded
into the assembly, applied by a new `DatabaseMigrator`. The directory gets a `README.md` stating
the contract, because the migrator outlives this feature: **files are append-only, named
`NNNN_description.sql` with a zero-padded four-digit sequence, applied in name order, and an
applied file is never edited** — the checksum check exists to catch exactly that.

```xml
<!-- LoopedIn.Api.csproj -->
<ItemGroup>
  <EmbeddedResource Include="Infrastructure/Database/Migrations/*.sql" />
</ItemGroup>
```

**How it runs:**

1. After `builder.Build()`, before `app.Run()` — only when an `NpgsqlDataSource` is registered
   (i.e. `DATABASE_URL` is set). Unconfigured stays a no-op, like every other dependency here.
2. `create table if not exists schema_migrations (id text primary key, checksum text not null,
   applied_at timestamptz not null default now())`.
3. `select id, checksum from schema_migrations` — if nothing is pending, verify checksums and
   return without taking any lock. This is the common path on a warm schema, and it keeps Lambda
   cold starts off the lock.
4. If something *is* pending, then **per pending file, on a single connection**:
   `BEGIN` → `select pg_advisory_xact_lock(hashtext('looped_in_migrations'))` → re-read
   `schema_migrations` for this id (another instance may have won) → apply the file → record
   id + checksum → `COMMIT`. The lock is **transaction-scoped, not session-scoped**, deliberately:
   `pg_advisory_lock` silently stops working through PgBouncer transaction pooling — which is
   exactly what Neon's pooled endpoint (§8) is — because acquire and release can land on different
   server connections. A `pg_advisory_xact_lock` inside an explicit transaction pins one server
   connection for its duration, so this design is safe on the pooled endpoint, the direct
   endpoint, and under Npgsql's own pooling, where each command otherwise draws a fresh
   connection. Concurrent Lambda cold starts serialize on the lock and each re-check turns the
   losers into no-ops.
5. A checksum mismatch on an already-applied file is a **hard failure** — an edited migration means
   the deployed schema and the repo disagree, and guessing which is right is worse than stopping.
6. Every migrator command sets an explicit `CommandTimeout` (30 s). The failure story below only
   works if the migrator *fails fast* — a hung connection at startup must become a reported
   failure, not a wedged boot. On Lambda the whole thing runs in the init phase; the step-3 fast
   path keeps warm-schema cold starts to one round-trip.

**On failure:** log the reason, set `DatabaseState` to unavailable with that reason, and let the
app boot. `/db/ping` and every `/clients` route then answer **503 with that reason**, exactly as
unconfigured S3 does today. Booting is right (the rest of the API is unaffected); serving CRUD
against a half-migrated schema is not.

**`DatabaseState` is a mutable holder, not a record re-registered on failure** — the DI container
is sealed once `builder.Build()` returns, so a post-build migration failure cannot "register" a
status. `AddNeonDatabase` registers the holder on **both** branches (unconfigured → it starts as
unavailable with the config message; configured → the migrator sets it to ready or failed). This
mirrors `DocumentStorageStatus` in role, but the mutability is forced by *when* migration outcomes
become known.

**Escape hatch:** if startup migration ever becomes unwanted on Lambda, the same migrator behind a
`--migrate` argument runs it as a one-shot from CI. Not built now — noted so the door stays open.

---

## 5. Backend

All new files under `backend/LoopedIn.Api/`. **No new NuGet packages** — Npgsql 10.0.3 is already
referenced, so `Directory.Packages.props` is untouched.

| File | Contents |
| --- | --- |
| `Infrastructure/Database/Migrations/0001_clients_contacts.sql` | The DDL in §3.1. |
| `Infrastructure/Database/Migrations/README.md` | The migration contract (§4): append-only, numbering, never edit an applied file. |
| `Infrastructure/Database/DatabaseMigrator.cs` | §4. |
| `Infrastructure/Database/DatabaseState.cs` | Mutable singleton holder: `Available` / `Reason`, set by config or the migrator (§4). |
| `Infrastructure/Database/ClientStore.cs` | All SQL, parameterized. Returns models; throws nothing the filter doesn't translate. |
| `Infrastructure/Http/ClaimsPrincipalExtensions.cs` | `GetSubject()` — the `NameIdentifier`-or-`sub` fallback, extracted once. |
| `Infrastructure/Http/DatabaseGateFilter.cs` | The shared preamble as an `IEndpointFilter` (§5.1). |
| `Models/Client.cs` | Request/response records (§5.2). |
| `Endpoints/ClientEndpoints.cs` | Route group + handlers, patterned on `DocumentEndpoints.cs`. |

`Program.cs` changes are three: `await app.Services.MigrateDatabaseAsync();`,
`app.MapClientEndpoints();`, and `/db/ping` grows a `DatabaseState` check so a migration failure
is visible there (today it only probes connectivity). `AddNeonDatabase` grows the `DatabaseState`
registration on both branches (§4).

### 5.1 Routes — and the shared preamble as composition, not copy

`DocumentEndpoints` hand-rolls its preamble (`WithStoreAsync`); copying that shape here would be
the second copy, and the `FindFirstValue(NameIdentifier) ?? FindFirstValue("sub")` line would
appear for the third time. This feature extracts instead — **this is the standard for future
route modules**:

- `app.MapGroup("/clients").RequireAuthorization().AddEndpointFilter<DatabaseGateFilter>()` —
  authorization stated once for the whole group, so a new route can't forget it.
- `DatabaseGateFilter` does what `WithStoreAsync` does, as composition: 503 with
  `DatabaseState.Reason` when the database is unconfigured or migration failed; 401 when the
  validated token carries no usable subject; wraps the handler to translate `NpgsqlException`
  into 503 — **except unique violations (SqlState 23505), which become the same 409 as the
  pre-check** (the check-then-insert race on `contacts_client_email_uniq` must not surface as a
  503, let alone a 500).
- `user.GetSubject()` replaces the claim-fallback line. A small mechanical commit retrofits
  `/me` and `DocumentEndpoints` to call it too, so there is one definition of "who is calling".

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/clients` | `?search=&industry=&limit=&offset=`. Returns `{ clients, total, limit, offset }`. Each row carries `contactCount`. Ordered by `(created_at desc, id desc)`. |
| `POST` | `/clients` | Create. 201 + the created client. |
| `GET` | `/clients/{id}` | Client **with its contacts**. |
| `PATCH` | `/clients/{id}` | Full replacement of the mutable fields + concurrency check (§5.3). |
| `DELETE` | `/clients/{id}` | Cascades contacts. 204. |
| `POST` | `/clients/{id}/contacts` | Add a contact. |
| `PATCH` | `/clients/{id}/contacts/{contactId}` | Update (scoped `where client_id = @clientId and id = @contactId`). |
| `DELETE` | `/clients/{id}/contacts/{contactId}` | 204. |

**No new `/clients/ping`** — `/db/ping` already probes this exact dependency (and now reports
migration state too), and a second public probe is another anonymous path to real database work.

### 5.2 Contracts

```csharp
public sealed record ClientSummary(Guid Id, string Name, string? Industry, string? Location,
    int ContactCount, long Version, DateTimeOffset UpdatedAt);
public sealed record ClientDetail(Guid Id, string Name, string? Industry, string? Location,
    string? Notes, IReadOnlyList<ContactSummary> Contacts, long Version,
    DateTimeOffset CreatedAt, string CreatedBy, DateTimeOffset UpdatedAt, string UpdatedBy);
public sealed record ContactSummary(Guid Id, string? FullName, string? Email, string? RoleTitle,
    string? Notes, long Version, DateTimeOffset UpdatedAt);
public sealed record ClientListResponse(IReadOnlyList<ClientSummary> Clients, int Total,
    int Limit, int Offset);

public sealed record CreateClientRequest(string? Name, string? Industry, string? Location, string? Notes);
public sealed record UpdateClientRequest(string? Name, string? Industry, string? Location,
    string? Notes, long? ExpectedVersion);
public sealed record CreateContactRequest(string? FullName, string? Email, string? RoleTitle, string? Notes);
public sealed record UpdateContactRequest(string? FullName, string? Email, string? RoleTitle,
    string? Notes, long? ExpectedVersion);
```

**PATCH is full replacement of the mutable fields, stated out loud.** With records and
System.Text.Json, an absent property and an explicit `null` both deserialize to `null` — true
merge-patch semantics can't be expressed. So: the client always sends all four fields (it edits
from a loaded row anyway); `name` is required; `industry` / `location` / `notes` as `null` means
**clear the field** — which the step-12 cleanup workflow genuinely needs. This is the house PATCH
semantics until a real merge-patch need appears.

**Validation, mirroring the DB checks** (so a violation is a 400, never a 500): trim everything;
`name` required and ≤ 200; a contact needs `fullName` or `email`; `email` conservatively
format-checked and lowercased for comparison; duplicate email under the same client → **409** with
a message naming the existing contact; `ExpectedVersion` missing on PATCH → **400** (§5.3). Error
bodies are RFC 7807 `problem+json` — `callBackend` already surfaces `detail` verbatim to users, so
those strings are UI copy and should read like it.

### 5.3 Concurrency

Shared writes mean two people can edit the same client. `PATCH` requires `expectedVersion`
(**400 without it** — optional would make the protection decorative the day the UI forgets to
send it); the `UPDATE` carries `set version = version + 1 … where id = @id and version =
@expected`. Zero rows affected is then disambiguated with one `select version from … where id =
@id`: no row → **404**; a row → **409 "This client was changed by someone else — reload and try
again."** An integer never has the round-trip problem a timestamp has (D5); `updatedAt` stays in
the payload for display only. `DELETE` takes no version — it is the last word, and the UI's
confirmation (naming the contact count) is the guard.

### 5.4 Search and paging

`ilike` across `name`, `industry`, `location`, plus contact name/email via `exists`. The search
term is escaped for LIKE semantics — `\`, `%` and `_` — and matched as
`ilike '%' || @search || '%' escape '\'`, so searching for `100%` means the literal string, not
"starts with 100". At ~200 rows a sequential scan is the correct answer; **pg_trgm is the fix if
this ever reaches five figures**, and no earlier. Paging is `limit`/`offset`, default 50, hard cap
200, with a `total` from a windowed count so the UI can render "51–100 of 190".

---

## 6. Frontend

New route `app/clients/`, following `app/documents/` exactly — that split exists because the client
component must not pull `@clerk/nextjs/server` into the browser bundle.

| File | Role |
| --- | --- |
| `app/clients/types.ts` | Mirrors §5.2. No server imports. `version` is a number; date fields stay **strings** end-to-end (display only — never parsed into `Date` and sent back). |
| `app/clients/actions.ts` | `"use server"` — create/update/delete for clients and contacts, each calling `refresh()` on success. |
| `app/clients/page.tsx` | Server component: reads `searchParams` (`search`, `page`), calls `callBackend<ClientListResponse>("/clients?…")` inside `<Suspense>`, with the 503/401 explainer blocks the documents page uses. |
| `app/clients/client-manager.tsx` | `"use client"` — table, search box, pager, create form, inline edit, delete confirm. **Renders from props**; mutations go through actions and new props arrive. A `useState` mirror goes stale on every edit. |
| `app/clients/[id]/page.tsx` | Detail view: one client, its contacts, add/edit/remove contact. |
| `app/clients/clients.module.css` | CSS Modules against the tokens — no Tailwind. |

**List state lives in the URL** — this is the mechanism, not a nicety: a client component cannot
call `callBackend` (it is server-only), so the search box and pager write `?search=&page=` via
`router.replace`, the server component re-reads `searchParams`, re-fetches, and new props arrive.
That is the same data flow as mutations (`refresh()`), it makes every list view bookmarkable, and
**it is the house pattern for list screens**. Default page size 50; the pager renders
"1–50 of 190" from `total`.

A **409 from a stale `expectedVersion` gets its own explainer** — the message from the API plus a
reload affordance, not a generic failure banner. That path will be exercised in normal use.

Two edits to existing files: a **Clients** link in `app/header-nav.tsx` (signed-in branch, first —
it becomes the primary surface), and nothing in `proxy.ts`, because `/` is an exact match and
everything else is protected by default.

**Styling** uses the design tokens only: `--li-surface` for the table ground, `--li-line` for row
rules, `--li-meta` + `--font-space-mono` for column headers and counts, `--li-radius-button` and
uppercase 700 for buttons. No raw hexes.

---

## 7. Import

`scripts/import_clients.py` — **Python 3.13 stdlib only** (`zipfile` + `xml.etree` + `uuid`). No
new dependency in any manifest, and python3.13 is already required on the deploy host for the MCP
Lambda build.

It reads the xlsx and **emits, rather than writes to the database**:

- `data/clients-import.sql` — idempotent inserts with **deterministic UUIDv5 ids** (D6): a fixed
  namespace (`uuid5(NAMESPACE_URL, "looped-in:client-import:2026-07-27")`), client ids derived
  from the normalized company name (never-merge rows salt with the row number), contact ids from
  `client-identity + "|" + lower(email)` (or the normalized name for name-only contacts). Every
  run of the script therefore emits byte-identical ids, so `on conflict (id) do nothing` really is
  idempotent — even from a regenerated file on another machine. Belt and braces, the whole script
  is guarded by the sentinel: it only inserts when no row with
  `created_by = 'import:datbase-list-2026-07-27'` exists, so even a rule change that alters the
  ids cannot double-import.
- `data/clients-import-report.md` — every judgment the script made, as a fix-it worklist for the UI.

**Rules** (D4 — import all, flag, never guess). The sub-rules here are **frozen**: the acceptance
numbers below were generated from exactly these rules against the real sheet, and the script
re-asserts them.

1. Skip rows 1–2. A row with no company name is skipped and reported (the current sheet has none).
2. Dedupe clients on the normalized name (trim, collapse whitespace, casefold). `unknown` is on a
   **never-merge list** — its 4 rows stay 4 clients.
3. Email cell: split on `,` `;` and newlines. If **every** part is a valid address → one contact
   per address. Otherwise `email` stays null, the raw cell is preserved in the contact's `notes`
   as `Original "Email" cell: …`, and the row is flagged. This single rule handles the LinkedIn
   URLs, the status note, the name-in-the-email-column cell, and the space-in-domain address — and
   still splits the two genuine multi-address cells (rows 44 and 112; note the second splits on a
   **newline**) into two contacts each.
   **3a.** When a cell splits into multiple addresses, the person name attaches to **no** contact —
   any assignment would be a guess. The original `Name` cell is copied into each resulting
   contact's notes and the row is flagged `name-not-attached`.
4. Dedupe contacts within a client by `lower(email)` first; then a name-only candidate is dropped
   (and flagged) if **any** existing contact of that client — email-bearing or not — has the same
   normalized name. This is what collapses the twice-recorded generic inbox and keeps the unique
   index satisfiable.
5. A contact is created only when a name or an email survives. A row whose email cell is junk
   *and* whose person cell is empty yields no contact — that is why "clients with no contact" (37)
   exceeds the 35 rows that had neither cell filled: rows 38 and 97 had a cell, but not a usable one.
6. **`industry`, `location` and `role_title` are copied verbatim.** `Goverment`, `Recriutment`,
   `Managing Directo` are *reported as suspected typos*, not corrected — fixing them is a
   two-minute job in the UI, and a script that guesses is a script you have to audit.
7. `«person», role` cells and `«name» and «name»` cells are kept verbatim and flagged with a
   suggested split.
8. Near-duplicate client names (equal after stripping a leading `the`) are reported for manual
   merge — this catches trap 2 of §2.
9. `created_by` = `updated_by` = `import:datbase-list-2026-07-27`.
10. Flags are counted **one per judgment**; a row can carry several.

**Expected output — these are the acceptance numbers, and the script asserts them itself** (it
exits non-zero and refuses to write `data/` when a count drifts, so a rule change can't slip
through as a "successful" run):

| Metric | Expected |
| --- | --- |
| clients | **190** (187 distinct names, less the merged doubles, plus `unknown`'s 4 rows kept apart) |
| contacts | **159** (146 with an email, 13 name-only) |
| clients with no contact | 37 |
| clients with >1 contact | 6 |
| flagged items in the report | **24** (6 unusable email cells, 11 person cells to split, 2 name-not-attached, 1 collapsed duplicate, 1 near-duplicate client pair, 3 suspected typos) |

**The spreadsheet itself stays untracked.** It holds ~150 named individuals' work contact details;
committing it puts personal data in git history permanently, where deleting the file does not
remove it. Add it to `.gitignore` (§9 step 0) so it can't be swept in by `git add -A`. The
generated `data/*.sql` and report carry the same data and get the same treatment — the importer
regenerates them from the source whenever needed (which is exactly why D6 makes ids
deterministic). **The same rule applies to this plan**: it is committed, so it quotes no real
names or addresses — examples are placeholders plus row numbers, and step 0 checks that stays true.

---

## 8. Infra

**No changes.** Verified: `DATABASE_URL` is already a required secret in
`infra/config/secrets.json`, already passed to the API Lambda at `infra/services/api.ts:31`,
already read from `env_file` in `docker-compose.yml`, and already documented in
`backend/.env.local.example`. The plumbing was built with the scaffold and has been waiting for a
table.

Two operational notes:

- **Use Neon's pooled endpoint** (`…-pooler.…`) for deployed stages. Lambda concurrency multiplies
  connections, and Npgsql's own pool is per-instance, so it cannot protect Neon's connection cap.
  The migrator's locking was designed for this (§4): transaction-scoped advisory locks survive
  PgBouncer transaction pooling; session-scoped ones do not.
- `backend/.env.local` does not exist yet on this machine — step 2 below creates it.

---

## 9. Sequence

Each step ends with a check that can fail; don't carry a broken step forward.

| # | Step | Done when |
| --- | --- | --- |
| 0 | Add `Datbase List – 27 July 2026.xlsx` and `data/` to `.gitignore`; confirm this plan quotes no real names/emails | `git status` is clean of the spreadsheet; a skim of this file finds placeholders only |
| 1 | **Restrict Clerk sign-up** (Dashboard → Restrictions: invite-only or allowlist) — §3.3 | A fresh sign-up attempt from a non-invited address is refused |
| 2 | `cp backend/.env.local.example backend/.env.local`, paste a Neon URL | `dotnet run --project LoopedIn.Api --launch-profile http` then `curl localhost:5114/db/ping` → `{ connected: true, … }` |
| 3 | Migration file + README + `DatabaseMigrator` + `DatabaseState`, wired in `Program.cs` | Second run applies nothing; `select * from schema_migrations` shows one row; `\d clients` matches §3.1; temporarily editing the applied `.sql` locally → boot logs the checksum failure and `/db/ping` reports it (then revert) |
| 4 | `Models/Client.cs` + `ClientStore` + `ClientEndpoints` + `DatabaseGateFilter` + `GetSubject()` (with the mechanical `/me` + documents retrofit) | `dotnet build LoopedIn.slnx` clean (warnings are errors); the 8 routes appear in `/openapi/v1.json` |
| 5 | Manual API pass with a real Clerk token — sign in at localhost:3000, then in the browser console `await window.Clerk.session.getToken()` and export it for curl | Create → list → get → patch → delete round-trips; no-token → 401; bad id → 404; stale `expectedVersion` → 409; missing `expectedVersion` → 400; duplicate email → 409 |
| 6 | `scripts/import_clients.py` | Report and SQL generated; the script's own assertions pass — **counts match §7 exactly** |
| 7 | Apply the seed: `psql "$DATABASE_URL" -f data/clients-import.sql` (or paste into Neon's SQL editor) | `select count(*) from clients` → 190, `contacts` → 159; re-applying changes nothing (sentinel guard) |
| 8 | `app/clients/` — list page first, read-only, with search + pager via `?search=&page=` | `npm run lint && npm run build` clean; first page renders 50 rows with "1–50 of 190"; `?search=` filters server-side |
| 9 | Create / edit / delete + the `[id]` contact view | Every mutation reflects without a manual reload (`refresh()` working); 503, 401 and stale-409 states render their explainers |
| 10 | Header link, empty state, delete confirmation naming the contact count | Signed-out → `/clients` redirects to sign-in |
| 11 | Full stack | `docker compose up --build -d`; `/clients` works through the Compose network on `BACKEND_URL` |
| 12 | Work the import report | The 24 flagged items resolved in the UI; the near-duplicate client pair merged; the 3 typos fixed |

Deploy is **not** in this plan. When it comes, it goes through the `deploy` skill, and the only new
considerations are that step 3's migrator runs on the first cold start of the new API Lambda, and
that seeding a deployed stage means running step 7 against that stage's `DATABASE_URL` — the
deterministic ids (D6) make that safe to do from a regenerated file.

---

## 10. Deliberately not doing — each one a recorded decision, not drift

- **`org_id` / multi-tenancy** — D2 chose one shared list. The retrofit risk is recorded in §3.3.
- **Roles or permissions** — every signed-in user can delete any client. Acceptable only because
  step 1 narrows who can sign in at all; state it out loud rather than implying safety that isn't
  there.
- **Soft delete / audit trail** — `DELETE` is permanent and cascades. `created_by`/`updated_by`
  answer "who", never "what changed". A `client_events` table is the fix when it's needed.
- **Typo normalization on industry/location** — deferred to the UI by D4.
- **Full-text or trigram search** — §5.4.
- **MCP tools over clients** — a natural follow-on (`list_clients`, `find_client`) once the API is
  stable, and the token-forwarding seam already exists. Out of scope here.
- **Interfaces on stores** — `ClientStore` stays concrete, like `DocumentStore`. The DI
  registration is the substitution seam; an interface with one implementation and no consumer is
  ceremony. **The written rule:** extract `IClientStore` the day a second implementation or a test
  double needs it, and not before.
- **Generated frontend types** — `app/clients/types.ts` is the third hand-mirrored contract file
  (after `/me` and documents). Tolerable at three; when a fourth appears, switch to generating
  from `/openapi/v1.json` (`openapi-typescript`, dev-only) rather than hand-writing a fifth.
- **Tests** — the repo has no test suite anywhere; verification stays build + run + curl, per §9.
  **Deferred again, consciously, on 2026-07-27** — this feature is the strongest argument yet for
  changing that, and two mitigations are built in: the importer asserts its own acceptance
  numbers (§7), and the migrator + request validation are written as pure, argument-in/result-out
  logic so they are unit-testable the day a test project exists. When one does, the first three
  targets are: migrator pending/checksum logic, request validation, and `ClientStore` against a
  disposable Postgres.

---

## 11. Open question

**Where does the spreadsheet's authority end?** After step 7 the database is the source of truth and
the xlsx is a historical artifact. If it is still being edited by hand elsewhere, the import needs
to become a repeatable sync (match on email, update in place) rather than a one-shot — a materially
different piece of work. Worth settling before step 6, not after.

*(Still open. The import was built as a one-shot, per the plan. Deterministic ids (D6) mean turning
it into a sync later is an `on conflict (id) do update` away, not a rewrite — but the matching rule
is the hard part and it hasn't been chosen.)*

---

## 12. Amendments made during implementation — 2026-07-27

Everything above was implemented as written except for the items below. Each is recorded here
because the plan is the committed record and it should not read as though it predicted things it
didn't.

**The flag count is 26, not 24, and the script asserts 26.** All five structural counts (190
clients, 159 contacts, 146 with an email, 13 name-only, 37 with no contact, 6 with more than one)
came out exactly as §7 predicted on the first run. Two flag categories did not:

- **A fourth typo.** §7 named three (`Goverment`, `Managing Directo` on row 5, `Recriutment`). Row
  85 holds `Managing Diretor` — a second, differently-misspelled `Managing Director` the hand-count
  missed. The importer detects typos generically (Damerau–Levenshtein distance 1 against a strictly
  more common value in the same column) rather than from a fixed list, so it found it. Hardcoding
  three to preserve the number would have hidden a real cleanup item from step 12.
- **A merge conflict §7's rules never covered.** Rows 14 and 128 are one company under one name, so
  they merge into one client — but they disagree about Industry (`Tourism` vs `Goverment`). Rule 2
  says to dedupe on the name
  and says nothing about conflicting fields; taking the first silently would have dropped the
  second — and in this case dropped a typo worth seeing. The importer keeps the first, preserves
  the discarded value in the client's `notes`, and flags it. That is D4 ("nothing is dropped")
  applied to a case D4 didn't anticipate.

Two smaller rule details that §7 left implicit and the script had to settle:

- **A trailing dot does not make an address unusable.** Three cells end in a full stop. §7's own
  count of "6 unusable email cells" only works if they are treated as valid, so they are — and
  `ClientValidation.IsPlausibleEmail` in the API was aligned to match. Getting this wrong in the
  other direction was caught during verification: the API's first draft rejected them, which would
  have made three seeded contacts impossible to edit.
- **Junk with nowhere to go lands on the client.** Rule 5 says rows 38 and 97 yield no contact, but
  §7 never said where their unparseable email cell goes. It goes into the client's `notes`, because
  "nothing is dropped" outranks tidiness.
- **Short acronyms are excluded from typo detection** (minimum length 5). Without that guard the
  detector reported `CMO` and `COO` as misspellings of `CEO`, and `SA` as one of `USA`.

**§5's file table gained one file.** `Models/ClientValidation.cs` — §5.3 specifies the validation
rules but §5 lists no file for them, and putting them in the endpoint module would contradict §10's
commitment to keeping validation unit-testable.

**Two files were added to §6.** `app/clients/api-error.tsx` (the 503/401/404 explainers, shared by
the list and detail pages rather than written twice) and `app/clients/[id]/client-detail.tsx` (the
detail page needs a client component for the same reason the list does).

**§6's "inline edit" needed a mechanism §5.2 didn't provide.** PATCH replaces every mutable field,
but `ClientSummary` carries no `notes` — so a naive inline edit from a list row would silently wipe
them. `updateClientFromRow` reads the current notes first and passes them through. That cannot open
a lost-update window, because `expectedVersion` still comes from the version the *row was rendered
with*: if anything changed in between, the PATCH 409s.

**One repair outside the plan's scope.** `AddNeonDatabase` now catches a malformed `DATABASE_URL`
and degrades to the same 503 an unset one produces. Previously it threw during registration and
took the whole API down — including `/documents` and `/me`, which have nothing to do with Postgres.
Adding `DatabaseState` made the consistent behaviour available, so it was worth two lines.
