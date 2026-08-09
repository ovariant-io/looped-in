"""Helpers shared by the API-wrapping tool modules.

Every tool that fronts the Looped In API performs the same two steps before its
real work: read the caller's verified Clerk token and resolve the shared
`LoopedInApiClient`. Both failure modes are wiring/config faults rather than user
errors, so they raise clear `ToolError`s instead of leaking an AttributeError or
sending a request the API would reject. Kept here (not per-module) so new domains
import the behavior instead of re-copying it.
"""

from __future__ import annotations

import uuid
from datetime import date

from fastmcp.exceptions import ToolError
from fastmcp.server.dependencies import get_access_token

from looped_in_mcp.backend import LoopedInApiClient
from looped_in_mcp.deps import Deps

# Tool-annotation vocabularies, machine-readable per the MCP spec (absent
# annotations, clients must assume the worst). Three write shades because a
# client may gate its confirmation UI on them: a create only ever adds a row, an
# update overwrites fields someone else may have just written, and a delete is
# the one that cannot be undone (though re-running it changes nothing further,
# hence idempotent).
READ_ONLY = {"readOnlyHint": True, "idempotentHint": True}
ADDITIVE = {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False}
OVERWRITE = {"readOnlyHint": False, "destructiveHint": True, "idempotentHint": False}
REMOVAL = {"readOnlyHint": False, "destructiveHint": True, "idempotentHint": True}


def caller_token() -> str:
    """The caller's verified Clerk JWT, to forward to the Looped In API as Bearer.

    Behind RemoteAuthProvider every tool call carries a verified token, so a
    missing one is a wiring fault, not a user error — surface it clearly rather
    than sending an unauthenticated request the API would 401.
    """
    access = get_access_token()
    if access is None or not access.token:
        raise ToolError("No authenticated caller token on the request.")
    return access.token


def require_api(deps: Deps) -> LoopedInApiClient:
    """The shared API client, or a clear error when no backend is configured.

    `deps.api` is None locally (no BACKEND_URL) — API-wrapping tools cannot work
    without it, so they fail with an actionable, 503-style message instead of an
    AttributeError, mirroring the API's own "no-op gracefully when unconfigured".
    """
    if deps.api is None:
        raise ToolError(
            "The Looped In API is not configured for this MCP server (BACKEND_URL "
            "is unset), so API-backed tools are unavailable."
        )
    return deps.api


def uuid_arg(value: str, noun: str) -> str:
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


def wire_value(value: object) -> object:
    """A tool-parameter value as the API expects it on the wire (dates → ISO)."""
    return value.isoformat() if isinstance(value, date) else value


def replacement_body(
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
            body[wire] = wire_value(value)
        else:
            body[wire] = current.get(wire)
    return body
