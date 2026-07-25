/**
 * Shapes returned by the .NET API's /documents endpoints.
 *
 * Kept in their own module — with no server-only imports — so the client component can import
 * them without pulling `@clerk/nextjs/server` into the browser bundle. (`ApiResult` lives with
 * the call that produces it, in app/lib/backend.ts.)
 */

/** A row in the document list. */
export type DocumentSummary = {
  id: string;
  filename: string;
  size: number;
  /** ISO 8601. */
  lastModified: string;
};

/**
 * A single document, including the content type S3 recorded. Absent from
 * {@link DocumentSummary} because listing objects in S3 does not return metadata, and fetching
 * it would cost one extra request per row.
 */
export type DocumentDetail = DocumentSummary & {
  contentType: string;
  eTag: string | null;
};

export type DocumentListResponse = {
  documents: DocumentSummary[];
  /** True when the owner has more documents than one listing enumerates. */
  truncated: boolean;
};

/**
 * A presigned S3 upload target. `requiredHeaders` must be sent on the PUT verbatim — they are
 * part of the signature, so changing or dropping one makes S3 answer 403.
 */
export type UploadTarget = {
  id: string;
  filename: string;
  uploadUrl: string;
  requiredHeaders: Record<string, string>;
  /** ISO 8601. */
  expiresAt: string;
};

/** A short-lived presigned download URL. */
export type DocumentContent = {
  id: string;
  filename: string;
  contentType: string;
  downloadUrl: string;
  /** ISO 8601. */
  expiresAt: string;
};
