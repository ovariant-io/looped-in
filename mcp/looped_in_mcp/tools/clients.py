"""Read-only tools over the client pipeline — the shared outreach list.

These rows are a *team* resource: every signed-in user reads and writes the same
list, so these tools answer "what is the state of *our* pipeline", not "what is
mine". They map 1:1 onto the API's GET surface under `/clients` and forward the
caller's Clerk token, so the API's own auth and database gating do all the work.

Read-only by design. Mutations (create, edit, status transitions, logging
interactions) need the API's optimistic-concurrency `expectedVersion` flow and a
deliberate decision about how much an agent may change a shared list — they stay
off the MCP surface until that is designed on purpose.
"""

from __future__ import annotations

import uuid
from typing import Literal

from fastmcp import FastMCP
from fastmcp.exceptions import ToolError

from looped_in_mcp.deps import Deps
from looped_in_mcp.tools.common import READ_ONLY, caller_token, require_api

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


def _client_path(client_id: str, suffix: str = "") -> str:
    """`/clients/{id}{suffix}` with the id validated as a UUID first.

    The API's routes constrain `{id:guid}`, so a malformed id never reaches a
    handler — it comes back as a bare routing 404, indistinguishable from a
    missing client. Refusing it here keeps the API's 404 meaning exactly one
    thing, and the canonical form is what goes on the wire.
    """
    try:
        parsed = uuid.UUID(client_id)
    except ValueError:
        raise ToolError(f'"{client_id}" is not a valid client id — expected a UUID.') from None
    return f"/clients/{parsed}{suffix}"


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
        `total` (matches before paging), `limit` (default 50, max 200) and
        `offset` — page until `offset + limit >= total`. Summaries omit the
        prose fields; use `get_client` for the full record.
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
        `notes`) and the lifecycle ones (`status`, `acquiredAt`, `source`,
        `owner`, `lostReason` — set only when status is `lost`). `owner`,
        `createdBy` and `updatedBy` are raw Clerk user ids — there is no user
        directory, so compare against `whoami`'s `sub` to recognise the caller.
        `version` is the optimistic-concurrency token; it matters only to future
        write tools.
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
