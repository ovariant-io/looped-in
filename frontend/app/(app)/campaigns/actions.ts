"use server";

import { refresh } from "next/cache";
import { callBackend, type ApiResult } from "@/app/lib/backend";
import type {
  CampaignDetail,
  CampaignFields,
  CampaignMessage,
  CampaignMessageState,
  MessageFields,
} from "./types";

/**
 * Server Actions backing the campaigns UI, following clients/actions.ts exactly: each one
 * re-reads the Clerk session inside `callBackend` (Server Actions are reachable by direct POST),
 * campaigns share the clients' everyone-signed-in trust model, and mutations call `refresh()`
 * inside `if (result.ok)` so the server component re-renders with fresh props.
 */

export async function createCampaign(
  fields: CampaignFields,
): Promise<ApiResult<CampaignDetail>> {
  const result = await callBackend<CampaignDetail>("/campaigns", {
    method: "POST",
    body: fields,
  });

  if (result.ok) {
    refresh();
  }

  return result;
}

/**
 * Full replacement of a campaign's mutable fields. `expectedVersion` must be the version the
 * user's screen was rendered from — a 409 asks them to reload rather than silently discarding
 * someone else's edit.
 */
export async function updateCampaign(
  id: string,
  fields: CampaignFields,
  expectedVersion: number,
): Promise<ApiResult<CampaignDetail>> {
  const result = await callBackend<CampaignDetail>(
    `/campaigns/${encodeURIComponent(id)}`,
    { method: "PATCH", body: { ...fields, expectedVersion } },
  );

  if (result.ok) {
    refresh();
  }

  return result;
}

export async function deleteCampaign(id: string): Promise<ApiResult<void>> {
  const result = await callBackend<void>(`/campaigns/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });

  if (result.ok) {
    refresh();
  }

  return result;
}

/**
 * Drafts a message into a campaign. One per client — the API answers 409 (with a message naming
 * the fix) when the client already has one.
 */
export async function addMessage(
  campaignId: string,
  clientId: string,
  fields: MessageFields,
): Promise<ApiResult<CampaignMessage>> {
  const result = await callBackend<CampaignMessage>(
    `/campaigns/${encodeURIComponent(campaignId)}/messages`,
    { method: "POST", body: { clientId, ...fields } },
  );

  if (result.ok) {
    refresh();
  }

  return result;
}

export async function updateMessage(
  campaignId: string,
  messageId: string,
  fields: MessageFields,
  expectedVersion: number,
): Promise<ApiResult<CampaignMessage>> {
  const result = await callBackend<CampaignMessage>(
    `/campaigns/${encodeURIComponent(campaignId)}/messages/${encodeURIComponent(messageId)}`,
    { method: "PATCH", body: { ...fields, expectedVersion } },
  );

  if (result.ok) {
    refresh();
  }

  return result;
}

export async function deleteMessage(
  campaignId: string,
  messageId: string,
): Promise<ApiResult<void>> {
  const result = await callBackend<void>(
    `/campaigns/${encodeURIComponent(campaignId)}/messages/${encodeURIComponent(messageId)}`,
    { method: "DELETE" },
  );

  if (result.ok) {
    refresh();
  }

  return result;
}

/**
 * Moves a message to a new state via the dedicated transition endpoint — the only carrier of
 * state. Entering `sent` stamps `sentAt` and appends an `email` interaction to the client's
 * outreach log atomically; leaving `sent` clears the stamp again.
 */
export async function setMessageState(
  campaignId: string,
  messageId: string,
  state: CampaignMessageState,
  expectedVersion: number,
): Promise<ApiResult<CampaignMessage>> {
  const result = await callBackend<CampaignMessage>(
    `/campaigns/${encodeURIComponent(campaignId)}/messages/${encodeURIComponent(messageId)}/state`,
    { method: "POST", body: { state, expectedVersion } },
  );

  if (result.ok) {
    refresh();
  }

  return result;
}
