-- 0001_clients_contacts
--
-- The first schema in this repo. Documents deliberately have no table (S3 is the whole source
-- of truth), so this migration also establishes the house patterns every later table follows:
-- a `version` column for optimistic concurrency, created_by/updated_by holding the Clerk `sub`,
-- and CHECK constraints that mirror the API's own validation so a violation is a 400 and never
-- a 500.
--
-- APPEND-ONLY. Once applied anywhere, this file must never be edited — see README.md.

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

-- Case-insensitive name lookup without CREATE EXTENSION citext: a functional index costs
-- nothing and keeps this migration runnable by the app's own Neon role, which may not hold
-- the privilege to install an extension.
create index if not exists clients_name_lower_idx  on clients (lower(name));

-- Matches the list query's ORDER BY exactly. The id tiebreak is what makes paging stable when
-- rows share a created_at — which every imported row does.
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
    -- A contact with neither a name nor an email is a row with no way to identify a person.
    -- 35 spreadsheet rows have a company and nothing else — those become clients with zero
    -- contacts, which is why `contacts` is optional rather than why this check is lenient.
    constraint contacts_identifiable check (full_name is not null or email is not null)
);

create index if not exists contacts_client_idx on contacts (client_id, created_at);

-- Unique PER CLIENT, not globally: two people at different companies can legitimately share a
-- shared inbox, and the source data already proves a global constraint would fail.
create unique index if not exists contacts_client_email_uniq
    on contacts (client_id, lower(email)) where email is not null;
