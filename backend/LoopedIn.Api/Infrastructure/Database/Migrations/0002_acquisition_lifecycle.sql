-- 0002_acquisition_lifecycle
--
-- Turns the client list into a pipeline: lifecycle columns on clients, an append-only
-- status-transition audit table, and a per-client interaction log.
--
-- Decisions worth knowing before touching any of this:
--
--   * status/lost_reason are written ONLY by the status-transition endpoint, never by PATCH.
--     That is what makes the cross-column clients_lost_reason_shape CHECK safe: PATCH cannot
--     leave a reason stranded on a non-lost row because it never sets either column.
--   * acquired_at is set by the transition statement (coalesce(acquired_at, current_date))
--     the first time a client becomes active_client. current_date runs in the DB session
--     timezone — UTC on Neon — so a late-night AEST transition can record the previous day.
--     Accepted: this is a pipeline date, not an accounting one.
--   * clients_status_allowed is a NAMED constraint so a later migration can extend the list
--     with `alter table clients drop constraint clients_status_allowed` + re-add. The history
--     columns deliberately carry NO status CHECK — their values are copied from the already-
--     constrained clients.status, so extending the list stays a one-constraint change.
--   * No index on clients.status: the list filter joins the existing sequential scan, which is
--     correct at ~200 rows for the same reason 0001 skipped pg_trgm.
--
-- APPEND-ONLY. Once applied anywhere, this file must never be edited — see README.md.

-- One alter per column: each rides its own `if not exists`, and clients_lost_reason_shape can
-- reference status because the column exists by the time this statement runs (all of this file
-- applies inside one transaction either way).
alter table clients add column if not exists status text not null default 'lead'
    constraint clients_status_allowed check (status in
        ('lead', 'contacted', 'in_discussion', 'proposal_sent',
         'active_client', 'former_client', 'lost', 'do_not_contact'));

alter table clients add column if not exists acquired_at date null;

alter table clients add column if not exists source text null
    constraint clients_source_length check (source is null or length(source) <= 100);

alter table clients add column if not exists owner text null
    constraint clients_owner_length check (owner is null or length(owner) <= 200);

alter table clients add column if not exists lost_reason text null
    constraint clients_lost_reason_shape check
        (lost_reason is null or (status = 'lost' and length(lost_reason) <= 500));

-- Every transition, forever. No version / updated_* columns: rows here are written once by the
-- transition statement and never touched again — immutable audit, not a mutable record.
create table if not exists client_status_history (
    id          uuid        primary key,
    client_id   uuid        not null references clients (id) on delete cascade,
    from_status text        not null,
    to_status   text        not null,
    changed_at  timestamptz not null default now(),
    changed_by  text        not null
);

-- Matches the history read's ORDER BY exactly; the id tiebreak keeps same-instant rows stable.
create index if not exists client_status_history_client_idx
    on client_status_history (client_id, changed_at desc, id desc);

-- The outreach log. contact_id is `on delete set null` on purpose: pruning a contact must not
-- silently erase the record that a call or meeting happened — the entry just loses its person.
create table if not exists interactions (
    id           uuid        primary key,
    client_id    uuid        not null references clients (id) on delete cascade,
    contact_id   uuid        null references contacts (id) on delete set null,
    kind         text        not null check (kind in
                     ('email', 'call', 'meeting', 'linkedin', 'proposal', 'note', 'other')),
    occurred_on  date        not null,
    summary      text        not null check (length(btrim(summary)) between 1 and 2000),
    follow_up_on date        null,
    version      bigint      not null default 1,
    created_at   timestamptz not null default now(),
    created_by   text        not null,
    updated_at   timestamptz not null default now(),
    updated_by   text        not null
);

-- Matches the interaction list's ORDER BY exactly (occurred_on desc, created_at desc, id desc).
create index if not exists interactions_client_idx
    on interactions (client_id, occurred_on desc, created_at desc, id desc);

-- Lets the on-delete-set-null FK find its referencing rows without a sequential scan.
create index if not exists interactions_contact_idx
    on interactions (contact_id) where contact_id is not null;
