"""Tools over the client pipeline — the shared outreach list, reads and writes.

These rows are a *team* resource: every signed-in user reads and writes the same
list, so these tools answer "what is the state of *our* pipeline" — and, since
the write tools landed, change it. They map 1:1 onto the API surface under
`/clients` and forward the caller's Clerk token, so the API's own auth,
validation and database gating do all the work.

The write policy, decided on purpose rather than inherited from the API:

* Every update requires `expected_version` from a fresh read — the API's
  optimistic-concurrency token. A 409 means someone else edited the row between
  the read and the write; re-read and reconcile, never retry blind.
* The API's PATCH is a full replacement where a null CLEARS a field. Right for
  a form that just loaded the row and resends every field; for an agent it
  turns "update the notes" into wiping the website. So the update tools merge
  instead: they re-read the row, keep every field the caller did not mention,
  and null out only fields named in `clear`. The wire request is still the
  API's full replacement, still carrying the *caller's* `expected_version` —
  so a concurrent edit still surfaces as a 409, never as a silent overwrite of
  state the caller never saw.
* Deletes are real deletes with no undo. The delete tools say so in their
  schemas (`destructiveHint`) and their docstrings tell the agent to confirm
  with the user first — the API cannot enforce that; the tool contract is
  where an agent policy lives.
"""

from __future__ import annotations

import uuid
from datetime import date
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
    require_api,
)

# Mirrors ClientValidation.ClientStatuses in the API (itself mirroring the
# clients_status_allowed CHECK). A Literal rather than a pass-through string
# because the API *ignores* an unrecognised ?status= — right for a browser URL,
# a silent footgun for an agent, which would read the unfiltered result as the
# filtered answer. Putting the closed set in the tool schema refuses a bad value
# with the valid ones in hand. Change this together with the other mirrors.
ClientStatus = Literal[
    "lead",
    "contacted",
    "in_discussion",
    "proposal_sent",
    "active_client",
    "former_client",
    "lost",
    "do_not_contact",
]

# Mirrors ClientValidation.InteractionKinds (itself mirroring the
# interactions.kind CHECK) — a closed set in the schema for the same reason as
# ClientStatus. Change this together with the other mirrors.
InteractionKind = Literal["email", "call", "meeting", "linkedin", "proposal", "note", "other"]

# The fields each update tool may clear — snake_case because `clear` names the
# tool's own parameters, not the wire properties. Absentees are deliberate:
# a client keeps its name, an interaction its kind/date/summary, and a contact
# must keep a name or an email (clearing both is refused by the API, not here).
ClearableClientField = Literal[
    "industry", "location", "website", "what_they_do", "notes", "source", "owner"
]
ClearableContactField = Literal["full_name", "email", "role_title", "notes"]
ClearableInteractionField = Literal["follow_up_on", "contact_id"]

# (tool parameter, wire property) per entity — the merge tables behind the
# update tools. Every wire property of the API's full-replacement PATCH body
# must appear here: a missing row would silently clear that field on every
# update, which is exactly the failure the merge exists to prevent.
_CLIENT_FIELDS = [
    ("name", "name"),
    ("industry", "industry"),
    ("location", "location"),
    ("website", "website"),
    ("what_they_do", "whatTheyDo"),
    ("notes", "notes"),
    ("source", "source"),
    ("owner", "owner"),
]
_CONTACT_FIELDS = [
    ("full_name", "fullName"),
    ("email", "email"),
    ("role_title", "roleTitle"),
    ("notes", "notes"),
]
_INTERACTION_FIELDS = [
    ("kind", "kind"),
    ("occurred_on", "occurredOn"),
    ("summary", "summary"),
    ("follow_up_on", "followUpOn"),
    ("contact_id", "contactId"),
]


def _uuid(value: str, noun: str) -> str:
    """`value` as a canonical UUID string, or a clear ToolError naming `noun`.

    The API's routes constrain `{id:guid}`, so a malformed id never reaches a
    handler — it comes back as a bare routing 404, indistinguishable from a
    missing row. Refusing it here keeps the API's 404 meaning exactly one
    thing, and the canonical form is what goes on the wire.
    """
    try:
        return str(uuid.UUID(value))
    except ValueError:
        raise ToolError(f'"{value}" is not a valid {noun} — expected a UUID.') from None


def _client_path(client_id: str, suffix: str = "") -> str:
    """`/clients/{id}{suffix}` with the id validated as a UUID first."""
    return f"/clients/{_uuid(client_id, 'client id')}{suffix}"


def _wire_value(value: object) -> object:
    """A tool-parameter value as the API expects it on the wire (dates → ISO)."""
    return value.isoformat() if isinstance(value, date) else value


def _replacement_body(
    fields: list[tuple[str, str]],
    provided: dict[str, object],
    current: dict,
    clear: list[str] | None,
) -> dict:
    """The full-replacement PATCH body for one merge-style update.

    Provided values win, fields named in `clear` go null, and everything else
    re-sends what is stored now — which is what turns the API's replace-all
    PATCH into the merge the tool promises. Preserved values come from the row
    as the API just returned it, so they are already wire-shaped; only caller
    input needs converting.
    """
    cleared = set(clear or [])
    body: dict[str, object] = {}
    for param, wire in fields:
        value = provided[param]
        if param in cleared:
            if value is not None:
                raise ToolError(
                    f'"{param}" is both given a value and named in clear — pick one.'
                )
            body[wire] = None
        elif value is not None:
            body[wire] = _wire_value(value)
        else:
            body[wire] = current.get(wire)
    return body


def register(mcp: FastMCP, deps: Deps) -> None:
    @mcp.tool(annotations=READ_ONLY)
    async def list_clients(
        search: str | None = None,
        industry: str | None = None,
        status: ClientStatus | None = None,
        limit: int | None = None,
        offset: int | None = None,
    ) -> dict:
        """List the team's clients: a page of summaries plus the total match count.

        The client list is shared by the whole team, so this is the pipeline
        itself. Filters combine (AND). `search` matches a substring of the
        client's name, industry, or location, or of any contact's name or email —
        but not `website`/`whatTheyDo`; literal `%` and `_` are safe. `industry`
        is an exact match (case-insensitive), `status` one of the lifecycle
        stages. Results are paged newest-first: the response carries `clients`,
        `total` (matches before paging), `limit` (default 50, max 200 — an
        out-of-range request is clamped, and the response reports the limit
        actually applied) and `offset` — page until `offset + limit >= total`.
        Summaries omit the prose fields; use `get_client` for the full record.
        """
        params: dict[str, str | int] = {}
        if search is not None:
            params["search"] = search
        if industry is not None:
            params["industry"] = industry
        if status is not None:
            params["status"] = status
        if limit is not None:
            params["limit"] = limit
        if offset is not None:
            params["offset"] = offset
        api = require_api(deps)
        return await api.get_json("/clients", token=caller_token(), params=params)

    @mcp.tool(annotations=READ_ONLY)
    async def get_client(client_id: str) -> dict:
        """One client in full, including its contacts.

        The only reader that returns the prose fields (`website`, `whatTheyDo`,
        `notes`) and the lifecycle detail (`acquiredAt`, `source`, `owner`,
        `lostReason` — set only when status is `lost`); `status` itself is
        already on every `list_clients` summary. `owner`,
        `createdBy` and `updatedBy` are raw Clerk user ids — there is no user
        directory, so compare against `whoami`'s `sub` to recognise the caller.
        `version` is the optimistic-concurrency token: read it here (contacts
        carry their own) and pass it as `expected_version` to the write tools.
        """
        api = require_api(deps)
        return await api.get_json(_client_path(client_id), token=caller_token())

    @mcp.tool(annotations=READ_ONLY)
    async def get_client_status_history(client_id: str) -> list:
        """Every status transition a client has been through, newest first.

        Each entry records `fromStatus`, `toStatus`, when, and the Clerk user id
        that made the move — the append-only audit trail behind the client's
        current `status`. A `lost → lost` entry is how a lost reason was
        corrected, not a glitch. Returned whole (no paging); 404 means the
        client itself does not exist — a client with no transitions yet is an
        empty list.
        """
        api = require_api(deps)
        return await api.get_json(_client_path(client_id, "/status-history"), token=caller_token())

    @mcp.tool(annotations=READ_ONLY)
    async def list_client_interactions(client_id: str) -> list:
        """The outreach log for one client — every recorded touch, newest first.

        Each interaction carries a `kind` (email, call, meeting, linkedin,
        proposal, note, other), the date it `occurredOn`, a free-text `summary`,
        an optional `followUpOn` date, and `createdBy` (a raw Clerk user id).
        `contactId` links to one of the client's contacts when the touch was
        with a specific person; null means the contact was pruned or none was
        recorded. Returned whole (no paging); 404 means the client itself does
        not exist — a client with no logged touches is an empty list.
        """
        api = require_api(deps)
        return await api.get_json(_client_path(client_id, "/interactions"), token=caller_token())

    @mcp.tool(annotations=ADDITIVE)
    async def create_client(
        name: str,
        industry: str | None = None,
        location: str | None = None,
        website: str | None = None,
        what_they_do: str | None = None,
        notes: str | None = None,
        source: str | None = None,
        owner: str | None = None,
    ) -> dict:
        """Add a client to the team's shared pipeline. Only `name` is required.

        New clients start as `lead`; move them with `change_client_status`, the
        only writer of status. `owner` is a raw Clerk user id — use `whoami`'s
        `sub` to assign the client to the caller. The result carries the
        created `client` plus `warning`: a soft duplicate-name notice (company
        names are deliberately not unique) — when set, relay it to the user
        rather than silently creating a possible double. Add people afterwards
        with `add_client_contact`.
        """
        api = require_api(deps)
        body = {
            "name": name,
            "industry": industry,
            "location": location,
            "website": website,
            "whatTheyDo": what_they_do,
            "notes": notes,
            "source": source,
            "owner": owner,
        }
        return await api.post_json("/clients", token=caller_token(), json=body)

    @mcp.tool(annotations=OVERWRITE)
    async def update_client(
        client_id: str,
        expected_version: int,
        name: str | None = None,
        industry: str | None = None,
        location: str | None = None,
        website: str | None = None,
        what_they_do: str | None = None,
        notes: str | None = None,
        source: str | None = None,
        owner: str | None = None,
        clear: list[ClearableClientField] | None = None,
    ) -> dict:
        """Edit a client's descriptive fields. Send only what changed — a merge.

        Read the client first (`get_client`) and pass its `version` as
        `expected_version`; a 409 means someone else edited it in between —
        re-read and reconcile rather than retrying blind. Omitted fields keep
        their stored value; to empty one, name it in `clear` (a field cannot be
        both given and cleared). `status` is deliberately absent — a lifecycle
        move is an event, use `change_client_status`. `website` is normalized
        on write (https:// added when scheme-less; javascript:/data: schemes,
        userinfo `@` and non-ASCII hosts refused), so the stored value may
        differ from what was sent. Returns the updated client in full.
        """
        api = require_api(deps)
        token = caller_token()
        path = _client_path(client_id)
        current = await api.get_json(path, token=token)
        provided: dict[str, object] = {
            "name": name,
            "industry": industry,
            "location": location,
            "website": website,
            "what_they_do": what_they_do,
            "notes": notes,
            "source": source,
            "owner": owner,
        }
        body = _replacement_body(_CLIENT_FIELDS, provided, current, clear)
        body["expectedVersion"] = expected_version
        return await api.patch_json(path, token=token, json=body)

    @mcp.tool(annotations=OVERWRITE)
    async def change_client_status(
        client_id: str,
        status: ClientStatus,
        expected_version: int,
        lost_reason: str | None = None,
    ) -> dict:
        """Move a client through the pipeline — the only way status changes.

        `lead → contacted → in_discussion → proposal_sent → active_client` is
        the intended path; `former_client`, `lost` and `do_not_contact` sit
        outside it. A transition is an event: it appends to the audit history,
        stamps `acquiredAt` on the first move to `active_client`, and clears
        `lostReason` on any move away from `lost`. `lost_reason` may only
        accompany a move to `lost` (optional even then), and a same-status
        `lost → lost` move is how a recorded reason gets corrected. Requires
        `expected_version` from a fresh read; a 409 means the client changed in
        between — re-read. Returns the updated client in full.
        """
        api = require_api(deps)
        body = {
            "status": status,
            "lostReason": lost_reason,
            "expectedVersion": expected_version,
        }
        return await api.post_json(_client_path(client_id, "/status"), token=caller_token(), json=body)

    @mcp.tool(annotations=REMOVAL)
    async def delete_client(client_id: str) -> dict:
        """Permanently delete a client and everything attached to it. No undo.

        The cascade takes the client's contacts, its status history, and its
        whole interaction log. A client the team is merely done pursuing should
        be *moved* (`lost` or `do_not_contact`) so the record survives — delete
        only rows that are themselves mistakes (duplicates, test entries).
        Confirm with the user before deleting anything real.
        """
        api = require_api(deps)
        canonical = _uuid(client_id, "client id")
        await api.delete(_client_path(canonical), token=caller_token())
        return {"deleted": canonical}

    @mcp.tool(annotations=ADDITIVE)
    async def add_client_contact(
        client_id: str,
        full_name: str | None = None,
        email: str | None = None,
        role_title: str | None = None,
        notes: str | None = None,
    ) -> dict:
        """Add a person to a client. Needs at least a name or an email address.

        `email` must look like one — the API refuses implausible values (put
        the original text in `notes` instead), and a 409 means this client
        already has a contact with that email. Returns the created contact,
        whose `version` is what later edits pass as `expected_version`.
        """
        api = require_api(deps)
        body = {
            "fullName": full_name,
            "email": email,
            "roleTitle": role_title,
            "notes": notes,
        }
        return await api.post_json(_client_path(client_id, "/contacts"), token=caller_token(), json=body)

    @mcp.tool(annotations=OVERWRITE)
    async def update_client_contact(
        client_id: str,
        contact_id: str,
        expected_version: int,
        full_name: str | None = None,
        email: str | None = None,
        role_title: str | None = None,
        notes: str | None = None,
        clear: list[ClearableContactField] | None = None,
    ) -> dict:
        """Edit one of a client's contacts. Send only what changed — a merge.

        Contacts ride on the client detail: find the contact and its `version`
        via `get_client`, and pass that `version` as `expected_version`.
        Omitted fields keep their stored value; `clear` empties fields — though
        a contact must keep a name or an email, and clearing both is refused.
        A 409 is either a concurrent edit (re-read) or another contact on this
        client already holding the new email. Returns the updated contact.
        """
        api = require_api(deps)
        token = caller_token()
        canonical = _uuid(contact_id, "contact id")
        detail = await api.get_json(_client_path(client_id), token=token)
        current = next(
            (c for c in detail.get("contacts", []) if str(c.get("id")).lower() == canonical),
            None,
        )
        if current is None:
            raise ToolError(f"Client {detail.get('id')} has no contact {canonical}.")
        provided: dict[str, object] = {
            "full_name": full_name,
            "email": email,
            "role_title": role_title,
            "notes": notes,
        }
        body = _replacement_body(_CONTACT_FIELDS, provided, current, clear)
        body["expectedVersion"] = expected_version
        return await api.patch_json(
            _client_path(client_id, f"/contacts/{canonical}"), token=token, json=body
        )

    @mcp.tool(annotations=REMOVAL)
    async def delete_client_contact(client_id: str, contact_id: str) -> dict:
        """Permanently remove a contact from a client. No undo.

        Logged interactions that referenced this person survive — their
        `contactId` becomes null — so pruning a contact never erases the record
        that a touch happened. Confirm with the user before deleting anything
        real.
        """
        api = require_api(deps)
        canonical = _uuid(contact_id, "contact id")
        await api.delete(_client_path(client_id, f"/contacts/{canonical}"), token=caller_token())
        return {"deleted": canonical}

    @mcp.tool(annotations=ADDITIVE)
    async def add_client_interaction(
        client_id: str,
        kind: InteractionKind,
        occurred_on: date,
        summary: str,
        follow_up_on: date | None = None,
        contact_id: str | None = None,
    ) -> dict:
        """Log an outreach touch on a client — a call, email, meeting, or note.

        `occurred_on` and `follow_up_on` are dates without times (`YYYY-MM-DD`);
        `summary` is the free-text account of what happened. `contact_id`
        optionally names which of the client's contacts the touch was with —
        it must belong to this client (400 otherwise). Set `follow_up_on` when
        there is a next step: the log is how follow-ups are tracked, and a past
        `followUpOn` reads as overdue. Returns the created interaction, whose
        `version` is what later edits pass as `expected_version`.
        """
        api = require_api(deps)
        body = {
            "kind": kind,
            "occurredOn": occurred_on.isoformat(),
            "summary": summary,
            "followUpOn": follow_up_on.isoformat() if follow_up_on else None,
            "contactId": _uuid(contact_id, "contact id") if contact_id is not None else None,
        }
        return await api.post_json(
            _client_path(client_id, "/interactions"), token=caller_token(), json=body
        )

    @mcp.tool(annotations=OVERWRITE)
    async def update_client_interaction(
        client_id: str,
        interaction_id: str,
        expected_version: int,
        kind: InteractionKind | None = None,
        occurred_on: date | None = None,
        summary: str | None = None,
        follow_up_on: date | None = None,
        contact_id: str | None = None,
        clear: list[ClearableInteractionField] | None = None,
    ) -> dict:
        """Correct a logged interaction. Send only what changed — a merge.

        Find the entry and its `version` via `list_client_interactions`, and
        pass that `version` as `expected_version`. `kind`, `occurred_on` and
        `summary` are always kept when omitted and cannot be cleared; the
        clearable fields are `follow_up_on` (clearing it is how a completed
        follow-up is retired) and `contact_id`. A 409 means a concurrent edit —
        re-read. Returns the updated interaction.
        """
        api = require_api(deps)
        token = caller_token()
        canonical = _uuid(interaction_id, "interaction id")
        interactions = await api.get_json(_client_path(client_id, "/interactions"), token=token)
        current = next(
            (i for i in interactions if str(i.get("id")).lower() == canonical),
            None,
        )
        if current is None:
            raise ToolError(f"This client has no interaction {canonical}.")
        provided: dict[str, object] = {
            "kind": kind,
            "occurred_on": occurred_on,
            "summary": summary,
            "follow_up_on": follow_up_on,
            "contact_id": _uuid(contact_id, "contact id") if contact_id is not None else None,
        }
        body = _replacement_body(_INTERACTION_FIELDS, provided, current, clear)
        body["expectedVersion"] = expected_version
        return await api.patch_json(
            _client_path(client_id, f"/interactions/{canonical}"), token=token, json=body
        )

    @mcp.tool(annotations=REMOVAL)
    async def delete_client_interaction(client_id: str, interaction_id: str) -> dict:
        """Permanently remove one entry from a client's outreach log. No undo.

        The log is the team's memory of the relationship — delete entries that
        are wrong (duplicates, logged on the wrong client), never merely old.
        Confirm with the user before deleting anything real.
        """
        api = require_api(deps)
        canonical = _uuid(interaction_id, "interaction id")
        await api.delete(_client_path(client_id, f"/interactions/{canonical}"), token=caller_token())
        return {"deleted": canonical}
