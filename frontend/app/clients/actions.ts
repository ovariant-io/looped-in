"use server";

import { refresh } from "next/cache";
import { callBackend, type ApiResult } from "../lib/backend";
import type {
  ClientDetail,
  ClientFields,
  ContactFields,
  ContactSummary,
  CreateClientResponse,
} from "./types";

/**
 * Server Actions backing the clients UI.
 *
 * Each one re-reads the Clerk session inside `callBackend` rather than trusting anything the
 * client sent — Server Actions are reachable by direct POST, not only through the UI.
 *
 * **Note what that does and does not protect here.** For documents the real boundary is one
 * layer down: the API derives every S3 key from the token it validated itself, so a request
 * cannot name another user's data. Clients are shared across all signed-in users by design, so
 * there is no such boundary — authentication is the whole of it. That is why who may sign up to
 * the Clerk instance is a security decision for this feature and not just an onboarding one.
 *
 * Mutations call `refresh()` so the server component re-renders with the new data and the
 * manager receives fresh props. `refresh()` rather than `revalidatePath()` because these routes
 * are dynamic (they read `auth()`) and hold no cached data to invalidate.
 */

export async function createClient(
  fields: ClientFields,
): Promise<ApiResult<CreateClientResponse>> {
  const result = await callBackend<CreateClientResponse>("/clients", {
    method: "POST",
    body: fields,
  });

  if (result.ok) {
    refresh();
  }

  return result;
}

/**
 * Full replacement of a client's mutable fields.
 *
 * `expectedVersion` must be the version the user's screen was rendered from, never a freshly
 * read one — that is the entire point. If someone else has saved since, the API answers 409 and
 * the UI asks the user to reload rather than silently discarding the other edit.
 */
export async function updateClient(
  id: string,
  fields: ClientFields,
  expectedVersion: number,
): Promise<ApiResult<ClientDetail>> {
  const result = await callBackend<ClientDetail>(
    `/clients/${encodeURIComponent(id)}`,
    { method: "PATCH", body: { ...fields, expectedVersion } },
  );

  if (result.ok) {
    refresh();
  }

  return result;
}

/**
 * Edits a client from a list row, where `notes` is not on screen.
 *
 * PATCH replaces every mutable field, so sending `notes: null` from a list row would silently
 * wipe it. This reads the current notes first and passes them through unchanged.
 *
 * The read cannot open a lost-update window, because `expectedVersion` still comes from the
 * **caller** — the version the row was rendered with. If anyone changed the client between the
 * user loading the list and this call (including changing the notes we just read), the version
 * no longer matches and the PATCH answers 409.
 */
export async function updateClientFromRow(
  id: string,
  fields: Omit<ClientFields, "notes">,
  expectedVersion: number,
): Promise<ApiResult<ClientDetail>> {
  const current = await callBackend<ClientDetail>(
    `/clients/${encodeURIComponent(id)}`,
  );

  if (!current.ok) {
    return current;
  }

  return updateClient(id, { ...fields, notes: current.data.notes }, expectedVersion);
}

export async function deleteClient(id: string): Promise<ApiResult<void>> {
  const result = await callBackend<void>(`/clients/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });

  if (result.ok) {
    refresh();
  }

  return result;
}

export async function addContact(
  clientId: string,
  fields: ContactFields,
): Promise<ApiResult<ContactSummary>> {
  const result = await callBackend<ContactSummary>(
    `/clients/${encodeURIComponent(clientId)}/contacts`,
    { method: "POST", body: fields },
  );

  if (result.ok) {
    refresh();
  }

  return result;
}

export async function updateContact(
  clientId: string,
  contactId: string,
  fields: ContactFields,
  expectedVersion: number,
): Promise<ApiResult<ContactSummary>> {
  const result = await callBackend<ContactSummary>(
    `/clients/${encodeURIComponent(clientId)}/contacts/${encodeURIComponent(contactId)}`,
    { method: "PATCH", body: { ...fields, expectedVersion } },
  );

  if (result.ok) {
    refresh();
  }

  return result;
}

export async function deleteContact(
  clientId: string,
  contactId: string,
): Promise<ApiResult<void>> {
  const result = await callBackend<void>(
    `/clients/${encodeURIComponent(clientId)}/contacts/${encodeURIComponent(contactId)}`,
    { method: "DELETE" },
  );

  if (result.ok) {
    refresh();
  }

  return result;
}
