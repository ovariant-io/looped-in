"use server";

import { refresh } from "next/cache";
import { callBackend, type ApiResult } from "@/app/lib/backend";
import type { DocumentContent, DocumentDetail, UploadTarget } from "./types";

/**
 * Server Actions backing the documents UI.
 *
 * Each one re-reads the Clerk session inside `callBackend` rather than trusting anything the
 * client sent. That matters because Server Actions are reachable by direct POST, not only
 * through the UI — and the real authorization boundary is one layer further down anyway: the
 * API derives every S3 key from the `sub` of the token it validated itself, so an id belonging
 * to another user resolves to nothing under the caller's prefix.
 *
 * The mutating actions call `refresh()` so the server component re-renders with the new listing.
 * `refresh()` rather than `revalidatePath()` because this route is dynamic (it reads `auth()`)
 * and holds no cached data to invalidate — there is nothing to revalidate, only a client router
 * to bring up to date.
 */

/**
 * Step 1 of an upload: reserve an id and get a presigned PUT. Nothing exists in S3 until the
 * browser completes that PUT, so abandoning here leaves no debris.
 *
 * `size` is the byte length about to be sent. The API requires it so it can refuse an
 * oversized upload before signing anything — the check is advisory (S3 cannot enforce a length
 * on a query-signed PUT), but it turns "the file silently uploads and bills you" into a clear
 * 413 the UI can show before any bytes move.
 */
export async function createUploadTarget(
  filename: string,
  contentType: string,
  size: number,
): Promise<ApiResult<UploadTarget>> {
  return callBackend<UploadTarget>("/documents", {
    method: "POST",
    body: { filename, contentType, size },
  });
}

/** Step 3 of an upload: confirm the object landed and pick up the size and type S3 recorded. */
export async function completeUpload(
  id: string,
): Promise<ApiResult<DocumentDetail>> {
  const result = await callBackend<DocumentDetail>(
    `/documents/${encodeURIComponent(id)}/complete`,
    { method: "POST" },
  );

  if (result.ok) {
    refresh();
  }

  return result;
}

export async function renameDocument(
  id: string,
  filename: string,
): Promise<ApiResult<DocumentDetail>> {
  const result = await callBackend<DocumentDetail>(
    `/documents/${encodeURIComponent(id)}`,
    { method: "PATCH", body: { filename } },
  );

  if (result.ok) {
    refresh();
  }

  return result;
}

export async function deleteDocument(id: string): Promise<ApiResult<void>> {
  const result = await callBackend<void>(`/documents/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });

  if (result.ok) {
    refresh();
  }

  return result;
}

/**
 * Mints a short-lived presigned GET. Deliberately not called ahead of time for every row: a
 * download URL is a bearer capability, so it is minted on click and expires in minutes.
 */
export async function getDownloadUrl(
  id: string,
): Promise<ApiResult<DocumentContent>> {
  return callBackend<DocumentContent>(
    `/documents/${encodeURIComponent(id)}/content`,
  );
}
