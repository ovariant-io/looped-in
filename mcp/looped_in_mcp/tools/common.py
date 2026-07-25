"""Helpers shared by the API-wrapping tool modules.

Every tool that fronts the Looped In API performs the same two steps before its
real work: read the caller's verified Clerk token and resolve the shared
`LoopedInApiClient`. Both failure modes are wiring/config faults rather than user
errors, so they raise clear `ToolError`s instead of leaking an AttributeError or
sending a request the API would reject. Kept here (not per-module) so new domains
import the behavior instead of re-copying it.
"""

from __future__ import annotations

from fastmcp.exceptions import ToolError
from fastmcp.server.dependencies import get_access_token

from looped_in_mcp.backend import LoopedInApiClient
from looped_in_mcp.deps import Deps

# These tools never mutate anything — say so machine-readably (absent annotations,
# MCP clients must assume a tool may be destructive).
READ_ONLY = {"readOnlyHint": True, "idempotentHint": True}


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
