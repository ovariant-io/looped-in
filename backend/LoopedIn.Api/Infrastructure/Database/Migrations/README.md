# Migrations

Versioned SQL applied at startup by `DatabaseMigrator`. No migration tool, no ORM — numbered
`.sql` files embedded in the assembly and a `schema_migrations` table, which works identically
under `dotnet run`, in the Compose container, and on Lambda.

## The contract

1. **Files are append-only.** Name them `NNNN_description.sql` with a zero-padded four-digit
   sequence. They are applied in ordinal name order, which is why the padding matters — without
   it `10` sorts before `2`.
2. **An applied file is never edited.** Every file's SHA-256 is recorded when it is applied and
   re-checked on every boot. A mismatch is a **hard startup failure**, not a warning: it means
   the deployed schema and the repo disagree about what was run, and guessing which is right is
   worse than stopping. To change something already applied, add a new file.
3. **Every file must be idempotent on its own** (`create table if not exists`, `create index if
   not exists`, …). The `schema_migrations` check already prevents re-application, so this is
   belt and braces — but it is what makes a half-applied file recoverable by re-running.
4. **Each file runs inside one transaction**, so a statement that cannot (`CREATE INDEX
   CONCURRENTLY`, `VACUUM`, `ALTER TYPE … ADD VALUE` on older servers) does not belong here.
   Those go through a one-off run against the database, recorded in the file that expects them.
5. **Checksums are taken over newline-normalized text.** A CRLF checkout must not hard-fail a
   boot over a schema that did not change.
6. **Add nothing to the csproj.** `Infrastructure/Database/Migrations/*.sql` is a wildcard
   `EmbeddedResource`, so a new file is picked up by existing.

## How it runs

After `builder.Build()` and before `app.Run()`, and only when `DATABASE_URL` is set —
unconfigured is a no-op, like every other dependency here.

- **Fast path:** read `schema_migrations`; if nothing is pending, verify checksums and return
  **without taking any lock**. This is the common case on a warm schema and keeps Lambda cold
  starts down to one round-trip.
- **Applying:** per pending file, on one connection —
  `BEGIN` → `select pg_advisory_xact_lock(…)` → re-read `schema_migrations` for this id (another
  instance may have won the race) → apply → record id + checksum → `COMMIT`.
- **The lock is transaction-scoped on purpose.** `pg_advisory_lock` (session-scoped) silently
  stops working through PgBouncer transaction pooling — which is exactly what Neon's pooled
  endpoint is — because acquire and release can land on different server connections.
  `pg_advisory_xact_lock` inside an explicit transaction pins one server connection for its
  duration, so this is safe on the pooled endpoint, the direct endpoint, and under Npgsql's own
  pooling. Concurrent Lambda cold starts serialize on the lock, and the re-check turns the
  losers into no-ops.
- **Every command sets an explicit 30 s `CommandTimeout`.** The failure story below only works
  if the migrator fails *fast*: a hung connection at startup must become a reported failure, not
  a wedged boot.

## On failure

The app still boots. The reason is logged and stored in `DatabaseState`, and `/db/ping` plus
every `/clients` route then answer **503 with that reason** — the same shape unconfigured S3 has
today. Booting is right (the rest of the API is unaffected); serving CRUD against a
half-migrated schema is not.

## Escape hatch

If startup migration ever becomes unwanted on Lambda, the same migrator behind a `--migrate`
argument runs it as a one-shot from CI. Not built — noted so the door stays open.
