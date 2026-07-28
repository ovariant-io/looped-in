/**
 * Shapes returned by the .NET API's /clients endpoints.
 *
 * No server-only imports, so the client components can import these without pulling
 * `@clerk/nextjs/server` into the browser bundle. (`ApiResult` lives with the call that
 * produces it, in app/lib/backend.ts.)
 *
 * Two conventions to keep:
 *
 * - **`version` is the concurrency token**, and it is a plain number. Every edit sends the
 *   version it loaded; the API rejects the write if the row has moved on. The timestamps are
 *   for display only — never parse one into a `Date` and send it back, which is exactly the
 *   round-trip that made a timestamp unusable as the token in the first place.
 * - **Dates stay strings end to end.** They are rendered, not computed with.
 */

/**
 * The pipeline statuses, in funnel order. Mirrors `clients_status_allowed` in migration 0002 and
 * `ClientValidation.ClientStatuses` — change all three together.
 */
export const CLIENT_STATUSES = [
  "lead",
  "contacted",
  "in_discussion",
  "proposal_sent",
  "active_client",
  "former_client",
  "lost",
  "do_not_contact",
] as const;

export type ClientStatus = (typeof CLIENT_STATUSES)[number];

export const STATUS_LABELS: Record<ClientStatus, string> = {
  lead: "Lead",
  contacted: "Contacted",
  in_discussion: "In discussion",
  proposal_sent: "Proposal sent",
  active_client: "Active client",
  former_client: "Former client",
  lost: "Lost",
  do_not_contact: "Do not contact",
};

/** Mirrors the `interactions.kind` CHECK and `ClientValidation.InteractionKinds`. */
export const INTERACTION_KINDS = [
  "email",
  "call",
  "meeting",
  "linkedin",
  "proposal",
  "note",
  "other",
] as const;

export type InteractionKind = (typeof INTERACTION_KINDS)[number];

export const KIND_LABELS: Record<InteractionKind, string> = {
  email: "Email",
  call: "Call",
  meeting: "Meeting",
  linkedin: "LinkedIn",
  proposal: "Proposal",
  note: "Note",
  other: "Other",
};

/** A row in the client list. Deliberately without `notes` — see {@link ClientDetail}. */
export type ClientSummary = {
  id: string;
  name: string;
  industry: string | null;
  location: string | null;
  status: ClientStatus;
  contactCount: number;
  version: number;
  /** ISO 8601. Display only. */
  updatedAt: string;
};

export type ContactSummary = {
  id: string;
  fullName: string | null;
  email: string | null;
  roleTitle: string | null;
  notes: string | null;
  version: number;
  /** ISO 8601. Display only. */
  updatedAt: string;
};

/**
 * One client with its contacts, its prose, and its pipeline state.
 *
 * `notes` and `whatTheyDo` are absent from {@link ClientSummary} because a list of 50 rows does
 * not need thousands of characters each, and `website` follows them for a plainer reason: the
 * table is already seven columns wide and a client's identity belongs on its own page. That is
 * why an edit started from a list row has to fetch the detail before it can PATCH — PATCH is a
 * full replacement, so any omitted field would be cleared rather than left alone.
 */
export type ClientDetail = {
  id: string;
  name: string;
  industry: string | null;
  location: string | null;
  /**
   * An absolute http(s) URL with an ASCII host, normalized by the API — a scheme-less
   * `looped-in.com.au` is stored as `https://looped-in.com.au`, and anything that isn't a web
   * address is a 400. That is what makes it safe to drop straight into an `href`: without the
   * scheme it would resolve as a relative path, and without the allow-list a `javascript:` value
   * would be live on click.
   *
   * **Safe in an `href` is the whole promise.** The visible text names the host a browser will
   * dial, and nothing more — this is not a verified identity. `looped-in.com.au.evil.com` reads
   * like a client's own domain and is a perfectly valid value, so never treat it as proof of who
   * is on the other end.
   */
  website: string | null;
  /** Free text: what this organisation actually does. */
  whatTheyDo: string | null;
  notes: string | null;
  status: ClientStatus;
  /** yyyy-MM-dd, set by the API on the first transition to active_client. Display only. */
  acquiredAt: string | null;
  source: string | null;
  /** A Clerk user id. Rendered as "you" when it matches the signed-in user. */
  owner: string | null;
  /** Only ever non-null while `status` is "lost". */
  lostReason: string | null;
  contacts: ContactSummary[];
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
};

/** One recorded status transition. Immutable — no version, nothing to edit. */
export type StatusHistoryEntry = {
  id: string;
  fromStatus: ClientStatus;
  toStatus: ClientStatus;
  /** ISO 8601. Display only. */
  changedAt: string;
  changedBy: string;
};

/** One logged interaction. `createdBy` is who logged it — half the point of a log. */
export type InteractionSummary = {
  id: string;
  contactId: string | null;
  kind: InteractionKind;
  /** yyyy-MM-dd. Display only. */
  occurredOn: string;
  summary: string;
  /** yyyy-MM-dd or null. Display only. */
  followUpOn: string | null;
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
};

export type ClientListResponse = {
  clients: ClientSummary[];
  /** Rows matching the filters before paging — what "51–100 of 190" is rendered from. */
  total: number;
  limit: number;
  offset: number;
};

/**
 * The result of creating a client. `warning` is a soft duplicate-name notice: there is no
 * unique constraint on the name, so this is advice, not a rejection.
 */
export type CreateClientResponse = {
  client: ClientDetail;
  warning: string | null;
};

/**
 * The mutable fields of a client. All eight are always sent — PATCH replaces, it does not merge.
 * Status, acquiredAt and lostReason are deliberately absent: they move only through the
 * status-transition action, never through PATCH.
 */
export type ClientFields = {
  name: string;
  industry: string | null;
  location: string | null;
  /** Sent as typed; the API normalizes and validates it. See {@link ClientDetail.website}. */
  website: string | null;
  whatTheyDo: string | null;
  notes: string | null;
  source: string | null;
  owner: string | null;
};

/** The mutable fields of an interaction. All five are always sent — PATCH replaces. */
export type InteractionFields = {
  kind: InteractionKind;
  /** yyyy-MM-dd — exactly what `<input type="date">` produces. */
  occurredOn: string;
  summary: string;
  /** yyyy-MM-dd or null. */
  followUpOn: string | null;
  contactId: string | null;
};

/** The mutable fields of a contact. One of `fullName` / `email` must be present. */
export type ContactFields = {
  fullName: string | null;
  email: string | null;
  roleTitle: string | null;
  notes: string | null;
};

/** Rows per page. The API caps this at 200. */
export const PAGE_SIZE = 50;

/** The sentinel `created_by` carries on every row the spreadsheet import created. */
export const IMPORT_SENTINEL = "import:datbase-list-2026-07-27";
