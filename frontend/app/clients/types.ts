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

/** A row in the client list. Deliberately without `notes` — see {@link ClientDetail}. */
export type ClientSummary = {
  id: string;
  name: string;
  industry: string | null;
  location: string | null;
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
 * One client with its contacts and its notes. `notes` is absent from {@link ClientSummary}
 * because a list of 50 rows does not need up to 4 000 characters each — which is also why an
 * edit started from a list row has to fetch the detail before it can PATCH (PATCH is a full
 * replacement, so an omitted `notes` would clear the field).
 */
export type ClientDetail = {
  id: string;
  name: string;
  industry: string | null;
  location: string | null;
  notes: string | null;
  contacts: ContactSummary[];
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
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

/** The mutable fields of a client. All four are always sent — PATCH replaces, it does not merge. */
export type ClientFields = {
  name: string;
  industry: string | null;
  location: string | null;
  notes: string | null;
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
