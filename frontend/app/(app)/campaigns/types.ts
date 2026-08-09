/**
 * Shapes returned by the .NET API's /campaigns endpoints.
 *
 * No server-only imports, so the client components can import these without pulling
 * `@clerk/nextjs/server` into the browser bundle — same rules as clients/types.ts:
 * `version` is the concurrency token (a plain number), and dates stay strings end to end.
 */

/**
 * The message states, in workflow order. Mirrors `campaign_messages_state_allowed` in migration
 * 0004, `CampaignValidation.CampaignMessageStates`, and `CampaignMessageState` in
 * `mcp/looped_in_mcp/tools/campaigns.py` — plus the count columns on {@link CampaignSummary} and
 * the API's list query. Change every mirror together.
 */
export const CAMPAIGN_MESSAGE_STATES = [
  "drafted",
  "approved",
  "sent",
  "skipped",
] as const;

export type CampaignMessageState = (typeof CAMPAIGN_MESSAGE_STATES)[number];

export const MESSAGE_STATE_LABELS: Record<CampaignMessageState, string> = {
  drafted: "Drafted",
  approved: "Approved",
  sent: "Sent",
  skipped: "Skipped",
};

/**
 * A row in the campaign list. A campaign has no status of its own — the per-state counts ARE its
 * progress, derived from its messages by the API. The brief is deliberately absent, like a
 * client's prose fields.
 */
export type CampaignSummary = {
  id: string;
  name: string;
  messageCount: number;
  draftedCount: number;
  approvedCount: number;
  sentCount: number;
  skippedCount: number;
  version: number;
  /** ISO 8601. Display only. */
  updatedAt: string;
};

/**
 * One drafted email, joined by the API with the display names its ids point at. `state` and
 * `sentAt` move only through the state action, never through the edit PATCH.
 */
export type CampaignMessage = {
  id: string;
  clientId: string;
  clientName: string;
  contactId: string | null;
  /** Null when no recipient is set, or the contact was pruned (`on delete set null`). */
  contactName: string | null;
  subject: string;
  /** Plain text; paragraphs are separated by blank lines. The email template owns the markup. */
  body: string;
  state: CampaignMessageState;
  /** ISO 8601 or null — set entering `sent`, cleared on leaving it. Display only. */
  sentAt: string | null;
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
};

/**
 * A recipient choice: a contact of a client that already has a message in this campaign. Rides
 * on the detail (not per message) because list summaries carry contact counts, not contacts —
 * the detail read is the one place the options can come from without a per-message fetch.
 */
export type CampaignContactOption = {
  clientId: string;
  id: string;
  fullName: string | null;
  email: string | null;
};

/** One campaign with its messages, read whole like a client's contacts. */
export type CampaignDetail = {
  id: string;
  name: string;
  /** The drafting instruction: audience intent, offer, voice notes. */
  brief: string | null;
  messages: CampaignMessage[];
  contactOptions: CampaignContactOption[];
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
};

export type CampaignListResponse = {
  campaigns: CampaignSummary[];
  /** Rows matching the search before paging. */
  total: number;
  limit: number;
  offset: number;
};

/** The mutable fields of a campaign. Both are always sent — PATCH replaces, it does not merge. */
export type CampaignFields = {
  name: string;
  brief: string | null;
};

/**
 * The mutable fields of a message. All three are always sent — PATCH replaces. `state` is
 * deliberately absent: it moves only through the state action, which has send side effects.
 */
export type MessageFields = {
  subject: string;
  body: string;
  contactId: string | null;
};

/** Rows per page. The API caps this at 200. */
export const PAGE_SIZE = 50;
