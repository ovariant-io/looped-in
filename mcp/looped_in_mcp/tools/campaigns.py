"""Tools over EDM campaigns — drafting personalized emails into the pipeline.

A campaign is a brief plus one drafted message per client; nothing here sends
email. Drafting is the agent's job (personalize from what `get_client` and
`list_client_interactions` actually hold), review and sending are the human's,
and the tools record the outcome. These map 1:1 onto the API surface under
`/campaigns` and forward the caller's Clerk token, like `clients.py` — whose
write policy (merge-style updates, `expected_version` from a fresh read,
destructive tools that confirm with the user) applies here unchanged. So does
its read policy: a campaign's `contactOptions` name recipients without their
email addresses, since a message addresses a person by `contact_id` and the
sending happens in the app.
"""

from __future__ import annotations

from typing import Literal

from fastmcp import FastMCP
from fastmcp.exceptions import ToolError

from looped_in_mcp.deps import Deps
from looped_in_mcp.tools.common import (
    ADDITIVE,
    OVERWRITE,
    READ_ONLY,
    REMOVAL,
    caller_token,
    replacement_body,
    require_api,
    uuid_arg,
)
from looped_in_mcp.tools.redaction import redact_campaign

# Mirrors CampaignValidation.CampaignMessageStates in the API (itself mirroring
# the campaign_messages_state_allowed CHECK), with CAMPAIGN_MESSAGE_STATES in
# frontend/app/(app)/campaigns/types.ts and the count columns in the API's list
# read model as the other mirrors. A Literal for the reason ClientStatus is one.
# Change every mirror together.
CampaignMessageState = Literal["drafted", "approved", "sent", "skipped"]

# The fields each update tool may clear — snake_case because `clear` names the
# tool's own parameters. Absentees are deliberate: a campaign keeps its name,
# a message its subject and body; `contact_id` is clearable because a draft
# with no recipient yet is a supported shape.
ClearableCampaignField = Literal["brief"]
ClearableMessageField = Literal["contact_id"]

# (tool parameter, wire property) merge tables — every wire property of each
# full-replacement PATCH body must appear here, or a missing row would silently
# clear that field on every update.
_CAMPAIGN_FIELDS = [
    ("name", "name"),
    ("brief", "brief"),
]
_MESSAGE_FIELDS = [
    ("subject", "subject"),
    ("body", "body"),
    ("contact_id", "contactId"),
]


def _campaign_path(campaign_id: str, suffix: str = "") -> str:
    """`/campaigns/{id}{suffix}` with the id validated as a UUID first."""
    return f"/campaigns/{uuid_arg(campaign_id, 'campaign id')}{suffix}"


def register(mcp: FastMCP, deps: Deps) -> None:
    @mcp.tool(annotations=READ_ONLY)
    async def list_campaigns(
        search: str | None = None,
        limit: int | None = None,
        offset: int | None = None,
    ) -> dict:
        """List the team's campaigns: a page of summaries plus the total count.

        `search` matches a substring of the campaign name only — the brief is
        prose and not searched. Each summary carries the campaign's progress as
        per-state message counts (`messageCount`, `draftedCount`,
        `approvedCount`, `sentCount`, `skippedCount`) — a campaign has no
        status of its own. Results are paged newest-first with the same shape
        as `list_clients`: `total`, `limit` (default 50, max 200, clamped) and
        `offset` — page until `offset + limit >= total`. Summaries omit the
        brief; use `get_campaign` for the full record and the drafts.
        """
        params: dict[str, str | int] = {}
        if search is not None:
            params["search"] = search
        if limit is not None:
            params["limit"] = limit
        if offset is not None:
            params["offset"] = offset
        api = require_api(deps)
        return await api.get_json("/campaigns", token=caller_token(), params=params)

    @mcp.tool(annotations=READ_ONLY)
    async def get_campaign(campaign_id: str) -> dict:
        """One campaign in full: the brief and every drafted message.

        `messages` come whole (no paging) with full bodies, so the payload
        grows with the campaign — read it once and work from it rather than
        re-fetching per message. Each message names its client and recipient
        (`clientName`, `contactName`) alongside the ids, and carries the
        `version` its write tools need as `expected_version`; the campaign's
        own `version` guards `update_campaign`. `contactOptions` lists the
        contacts of every client already in the campaign — the valid
        `contact_id` choices when setting a message's recipient. Options name
        people, never their addresses (`hasEmail` reports whether one is on
        file); pick by `id` and let the app do the addressing.
        """
        api = require_api(deps)
        return redact_campaign(
            await api.get_json(_campaign_path(campaign_id), token=caller_token())
        )

    @mcp.tool(annotations=ADDITIVE)
    async def create_campaign(name: str, brief: str | None = None) -> dict:
        """Start a campaign. Only `name` is required.

        `brief` is the drafting instruction — who the campaign is for, the
        offer or message, and the voice to write in. Write it first (or ask the
        user for it): every message drafted into the campaign should be
        answerable to it. Returns the created campaign, whose `version` is what
        `update_campaign` passes as `expected_version`.
        """
        api = require_api(deps)
        body = {"name": name, "brief": brief}
        return redact_campaign(
            await api.post_json("/campaigns", token=caller_token(), json=body)
        )

    @mcp.tool(annotations=OVERWRITE)
    async def update_campaign(
        campaign_id: str,
        expected_version: int,
        name: str | None = None,
        brief: str | None = None,
        clear: list[ClearableCampaignField] | None = None,
    ) -> dict:
        """Edit a campaign's name or brief. Send only what changed — a merge.

        Read the campaign first (`get_campaign`) and pass its `version` as
        `expected_version`; a 409 means someone else edited it in between —
        re-read and reconcile rather than retrying blind. Omitted fields keep
        their stored value; `clear` can empty `brief` (a campaign keeps its
        name). Messages are edited through their own tools, not here. Returns
        the updated campaign in full.
        """
        api = require_api(deps)
        token = caller_token()
        path = _campaign_path(campaign_id)
        current = await api.get_json(path, token=token)
        provided: dict[str, object] = {"name": name, "brief": brief}
        body = replacement_body(_CAMPAIGN_FIELDS, provided, current, clear)
        body["expectedVersion"] = expected_version
        return redact_campaign(await api.patch_json(path, token=token, json=body))

    @mcp.tool(annotations=REMOVAL)
    async def delete_campaign(campaign_id: str) -> dict:
        """Permanently delete a campaign and every message in it. No undo.

        The cascade takes all of the campaign's drafts, whatever their state.
        Interactions already logged by recorded sends survive — they belong to
        the clients, not the campaign. A finished campaign is worth keeping as
        the record of what was sent; delete ones that are themselves mistakes.
        Confirm with the user before deleting anything real.
        """
        api = require_api(deps)
        # Canonicalized once, here — _campaign_path would just re-validate the same string.
        canonical = uuid_arg(campaign_id, "campaign id")
        await api.delete(f"/campaigns/{canonical}", token=caller_token())
        return {"deleted": canonical}

    @mcp.tool(annotations=ADDITIVE)
    async def add_campaign_message(
        campaign_id: str,
        client_id: str,
        subject: str,
        body: str,
        contact_id: str | None = None,
    ) -> dict:
        """Draft one client's email into a campaign.

        One message per client per campaign — a 409 means this client already
        has a draft here; edit that one (`update_campaign_message`) instead of
        adding a second. Check the client's status first: never draft to
        `do_not_contact`. `body` is plain text with paragraphs separated by
        blank lines — the app renders it into the branded email template, so
        send no markup. `contact_id` optionally names the recipient and must be
        a contact of this client (400 otherwise); it can be set later via the
        update tool. The message starts as `drafted`. Returns it with the
        `version` later edits pass as `expected_version`.
        """
        api = require_api(deps)
        wire_body = {
            "clientId": uuid_arg(client_id, "client id"),
            "contactId": uuid_arg(contact_id, "contact id") if contact_id is not None else None,
            "subject": subject,
            "body": body,
        }
        return await api.post_json(
            _campaign_path(campaign_id, "/messages"), token=caller_token(), json=wire_body
        )

    @mcp.tool(annotations=OVERWRITE)
    async def update_campaign_message(
        campaign_id: str,
        message_id: str,
        expected_version: int,
        subject: str | None = None,
        body: str | None = None,
        contact_id: str | None = None,
        clear: list[ClearableMessageField] | None = None,
    ) -> dict:
        """Revise a drafted message. Send only what changed — a merge.

        Find the message and its `version` via `get_campaign`, and pass that
        `version` as `expected_version`; a 409 means a concurrent edit —
        re-read. Omitted fields keep their stored value; `clear` can empty
        `contact_id` (a message keeps its subject and body — revise them,
        never blank them). A message never changes client: to redraft for a
        different client, delete this one and add another. `state` is
        deliberately absent — record outcomes with
        `set_campaign_message_state`. Returns the updated message.
        """
        api = require_api(deps)
        token = caller_token()
        canonical = uuid_arg(message_id, "message id")
        detail = await api.get_json(_campaign_path(campaign_id), token=token)
        current = next(
            (m for m in detail.get("messages", []) if str(m.get("id")).lower() == canonical),
            None,
        )
        if current is None:
            raise ToolError(f"Campaign {detail.get('id')} has no message {canonical}.")
        provided: dict[str, object] = {
            "subject": subject,
            "body": body,
            "contact_id": uuid_arg(contact_id, "contact id") if contact_id is not None else None,
        }
        wire_body = replacement_body(_MESSAGE_FIELDS, provided, current, clear)
        wire_body["expectedVersion"] = expected_version
        return await api.patch_json(
            _campaign_path(campaign_id, f"/messages/{canonical}"), token=token, json=wire_body
        )

    @mcp.tool(annotations=OVERWRITE)
    async def set_campaign_message_state(
        campaign_id: str,
        message_id: str,
        state: CampaignMessageState,
        expected_version: int,
    ) -> dict:
        """Record a message's outcome: drafted, approved, sent, or skipped.

        Any state can move to any state, same-state included. Entering `sent`
        is an event: it stamps `sentAt` and appends an `email` interaction to
        the client's outreach log **for you — do not also call
        `add_client_interaction`**, or the touch is double-logged. A repeated
        `sent` re-stamps nothing and logs nothing; leaving `sent` clears
        `sentAt` (and a mis-recorded send is retracted exactly that way — move
        the state back, then delete the stray interaction). Sending is a human
        act: set `sent` only when the user says the email actually went out,
        never because a draft looks finished. Requires `expected_version` from
        a fresh read; a 409 means the message changed in between — re-read.
        Returns the updated message.
        """
        api = require_api(deps)
        wire_body = {"state": state, "expectedVersion": expected_version}
        canonical = uuid_arg(message_id, "message id")
        return await api.post_json(
            _campaign_path(campaign_id, f"/messages/{canonical}/state"),
            token=caller_token(),
            json=wire_body,
        )

    @mcp.tool(annotations=REMOVAL)
    async def delete_campaign_message(campaign_id: str, message_id: str) -> dict:
        """Permanently remove one drafted message from a campaign. No undo.

        Interactions logged by its recorded sends survive on the client's log.
        A message the team decided not to send should be *moved* to `skipped`
        so the campaign records the decision — delete drafts that are
        themselves mistakes (wrong client, duplicates). Confirm with the user
        before deleting anything real.
        """
        api = require_api(deps)
        canonical = uuid_arg(message_id, "message id")
        await api.delete(_campaign_path(campaign_id, f"/messages/{canonical}"), token=caller_token())
        return {"deleted": canonical}
