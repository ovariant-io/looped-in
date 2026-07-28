"use server";

import { refresh } from "next/cache";
import { callBackend, type ApiResult } from "@/app/lib/backend";
import type {
  ClientDetail,
  ClientFields,
  ClientStatus,
  ContactFields,
  ContactSummary,
  CreateClientResponse,
  InteractionFields,
  InteractionSummary,
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
 * Edits a client from a list row, where `notes`, `source` and `owner` are not on screen.
 *
 * PATCH replaces every mutable field, so sending nulls for them from a list row would silently
 * wipe all three. This reads the current values first and passes them through unchanged — the
 * `Omit<>` on the parameter is what makes forgetting one a compile error rather than a wipe.
 *
 * The read cannot open a lost-update window, because `expectedVersion` still comes from the
 * **caller** — the version the row was rendered with. If anyone changed the client between the
 * user loading the list and this call (including changing the fields we just read), the version
 * no longer matches and the PATCH answers 409.
 */
export async function updateClientFromRow(
  id: string,
  fields: Omit<ClientFields, "notes" | "source" | "owner">,
  expectedVersion: number,
): Promise<ApiResult<ClientDetail>> {
  const current = await callBackend<ClientDetail>(
    `/clients/${encodeURIComponent(id)}`,
  );

  if (!current.ok) {
    return current;
  }

  return updateClient(
    id,
    {
      ...fields,
      notes: current.data.notes,
      source: current.data.source,
      owner: current.data.owner,
    },
    expectedVersion,
  );
}

/**
 * Moves a client to a new status via the dedicated transition endpoint — the only carrier of
 * status, so PATCH can never wipe it. The API records the transition in the status history,
 * stamps `acquiredAt` on the first move to active_client, and clears `lostReason` on any move
 * away from lost. `lostReason` may only accompany a change **to** lost.
 */
export async function changeClientStatus(
  id: string,
  status: ClientStatus,
  lostReason: string | null,
  expectedVersion: number,
): Promise<ApiResult<ClientDetail>> {
  const result = await callBackend<ClientDetail>(
    `/clients/${encodeURIComponent(id)}/status`,
    { method: "POST", body: { status, lostReason, expectedVersion } },
  );

  if (result.ok) {
    refresh();
  }

  return result;
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

export async function addInteraction(
  clientId: string,
  fields: InteractionFields,
): Promise<ApiResult<InteractionSummary>> {
  const result = await callBackend<InteractionSummary>(
    `/clients/${encodeURIComponent(clientId)}/interactions`,
    { method: "POST", body: fields },
  );

  if (result.ok) {
    refresh();
  }

  return result;
}

export async function updateInteraction(
  clientId: string,
  interactionId: string,
  fields: InteractionFields,
  expectedVersion: number,
): Promise<ApiResult<InteractionSummary>> {
  const result = await callBackend<InteractionSummary>(
    `/clients/${encodeURIComponent(clientId)}/interactions/${encodeURIComponent(interactionId)}`,
    { method: "PATCH", body: { ...fields, expectedVersion } },
  );

  if (result.ok) {
    refresh();
  }

  return result;
}

export async function deleteInteraction(
  clientId: string,
  interactionId: string,
): Promise<ApiResult<void>> {
  const result = await callBackend<void>(
    `/clients/${encodeURIComponent(clientId)}/interactions/${encodeURIComponent(interactionId)}`,
    { method: "DELETE" },
  );

  if (result.ok) {
    refresh();
  }

  return result;
}
