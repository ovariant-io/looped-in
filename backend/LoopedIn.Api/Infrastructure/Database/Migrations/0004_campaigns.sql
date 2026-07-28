-- 0004_campaigns
--
-- EDM campaign drafting: a campaigns table (the brief) and a per-client message table (the
-- drafts). No sending infrastructure exists — a "send" is a human act the API records.
--
-- Decisions worth knowing before touching any of this:
--
--   * Messages carry the state machine (drafted/approved/sent/skipped); campaigns have NO
--     status column. A campaign's progress is the derived per-state counts in the list read
--     model — which makes that query (CampaignStore.ListAsync), CampaignSummary, and the
--     frontend's chips de-facto mirror sites of campaign_messages_state_allowed, alongside
--     CampaignValidation.CampaignMessageStates, CAMPAIGN_MESSAGE_STATES in
--     frontend/app/(app)/campaigns/types.ts and CampaignMessageState in
--     mcp/looped_in_mcp/tools/campaigns.py. Change every mirror together.
--   * There is NO state-history table. The audit of a send is an `interactions` row (kind
--     'email'), appended atomically by the state-transition statement — the same
--     transition-as-event shape as client_status_history, except the record lands in the
--     client's ordinary outreach log, where a send belongs and where it stays correctable.
--   * state/sent_at are written ONLY by the state-transition endpoint, never by PATCH — the
--     same split that keeps clients.status honest. Transitions are free (any state to any
--     state, same-state included, mirroring lost → lost), but the interaction append is gated
--     on the PRE-update state, so `sent → sent` never fabricates a second touch.
--   * sent_at follows the lost_reason shape, not the acquired_at shape: it is set entering
--     `sent` (coalesce keeps the original stamp on a repeated sent) and CLEARED on leaving it,
--     because "drafted, sent at ..." is a row that lies. The transition statement's
--     occurred_on uses current_date, which runs UTC on Neon — a late-night AEST send can
--     record the previous day. Accepted, exactly as 0002 accepted it for acquired_at.
--   * body is capped at 10000 — deliberately past the notes tier (4000), because here the
--     body IS the artifact, not an annotation on one. subject sits on the name/title tier.
--   * campaign_messages_campaign_client_uniq: one draft per client per campaign. The grain is
--     the client, not the contact — a campaign emails an organisation once, addressed to a
--     chosen recipient. DatabaseGateFilter names this constraint to turn the losing insert of
--     a duplicate into a specific 409.
--
-- APPEND-ONLY. Once applied anywhere, this file must never be edited — see README.md.

create table if not exists campaigns (
    id          uuid        primary key,
    name        text        not null constraint campaigns_name_length
                                check (length(btrim(name)) between 1 and 200),
    -- The drafting instruction: audience intent, offer, voice notes. Notes-tier length.
    brief       text        null constraint campaigns_brief_length
                                check (brief is null or length(brief) <= 4000),
    version     bigint      not null default 1,
    created_at  timestamptz not null default now(),
    created_by  text        not null,
    updated_at  timestamptz not null default now(),
    updated_by  text        not null
);

-- No list-order index: campaigns will number in the dozens, so the list's sequential scan is
-- correct — the same deferral 0002 recorded for clients.status.

-- One drafted email per client per campaign. contact_id is the chosen recipient and is
-- `on delete set null` for the same reason interactions.contact_id is: pruning a contact must
-- not erase the draft — the message just loses its person.
create table if not exists campaign_messages (
    id          uuid        primary key,
    campaign_id uuid        not null references campaigns (id) on delete cascade,
    client_id   uuid        not null references clients (id) on delete cascade,
    contact_id  uuid        null references contacts (id) on delete set null,
    subject     text        not null constraint campaign_messages_subject_length
                                check (length(btrim(subject)) between 1 and 200),
    -- Plain text, paragraphs separated by blank lines. The renderer owns the markup, which is
    -- what keeps the rendered email first-party HTML with every interpolation escaped.
    body        text        not null constraint campaign_messages_body_length
                                check (length(btrim(body)) between 1 and 10000),
    state       text        not null default 'drafted' constraint campaign_messages_state_allowed
                                check (state in ('drafted', 'approved', 'sent', 'skipped')),
    sent_at     timestamptz null,
    version     bigint      not null default 1,
    created_at  timestamptz not null default now(),
    created_by  text        not null,
    updated_at  timestamptz not null default now(),
    updated_by  text        not null,
    constraint campaign_messages_campaign_client_uniq unique (campaign_id, client_id)
);

-- Matches the detail read's ORDER BY exactly (created_at, id). It overlaps the unique
-- constraint's (campaign_id, client_id) prefix on campaign_id alone, and is kept for the order
-- match — the unique index cannot serve the sorted scan.
create index if not exists campaign_messages_campaign_idx
    on campaign_messages (campaign_id, created_at, id);

-- Lets the on-delete-cascade FK from clients find its referencing rows without a sequential
-- scan — the unique index leads with campaign_id, so it cannot. Same rationale as
-- interactions_contact_idx in 0002.
create index if not exists campaign_messages_client_idx
    on campaign_messages (client_id);

-- Lets the on-delete-set-null FK find its referencing rows without a sequential scan.
create index if not exists campaign_messages_contact_idx
    on campaign_messages (contact_id) where contact_id is not null;
