"""The single seam between MCP tools and the Looped In .NET API.

`LoopedInApiClient` is the only place that calls the backend. Base URL, the
per-caller Clerk bearer token, timeouts, and HTTP-error → MCP-error translation
live here, so every API-wrapping tool stays a thin "validate input → call client →
shape result" and never reaches for `httpx` itself. That is what keeps the tool
surface from sprouting bespoke HTTP handling in a dozen places as tools accrue.

Built once per process (in the app lifespan, see app.py) and shared; the caller's
verified Clerk token is passed in per request — a tool-side helper reads it from
`get_access_token().token`. Kept free of FastMCP (beyond the error type) so it can
be unit-tested against a stub `httpx` transport with no MCP machinery.
"""

from __future__ import annotations

from typing import Any

import httpx
from fastmcp.exceptions import ToolError


class LoopedInApiError(ToolError):
    """A non-2xx Looped In API response, with the status code preserved.

    Tools mostly let this propagate as-is — the message already carries the
    method, path, status, and any RFC 7807 detail. Carrying the code lets a tool
    branch on a specific status (e.g. treat a 404 specially) without parsing the
    message text.
    """

    def __init__(self, message: str, *, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


class LoopedInApiClient:
    def __init__(
        self,
        base_url: str,
        *,
        client: httpx.AsyncClient | None = None,
        timeout: float = 30.0,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._client = client or httpx.AsyncClient(base_url=self._base_url, timeout=timeout)
        # Only close a client we created; an injected one (tests) is the caller's.
        self._owns_client = client is None

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def request(
        self,
        method: str,
        path: str,
        *,
        token: str,
        json: Any | None = None,
        params: dict[str, Any] | None = None,
    ) -> httpx.Response:
        """Call the Looped In API, forwarding the caller's Clerk token as Bearer auth.

        Raises ToolError on a transport failure or a non-2xx response so the tool
        surfaces a clean, client-safe MCP error instead of leaking a stack trace.
        """
        try:
            response = await self._client.request(
                method,
                path,
                headers={"Authorization": f"Bearer {token}"},
                json=json,
                params=params,
            )
        except httpx.HTTPError as exc:  # network / timeout — backend unreachable
            raise ToolError(f"Looped In API request to {path} failed: {exc}") from exc
        if response.is_error:
            raise LoopedInApiError(
                f"Looped In API {method} {path} → {response.status_code} {response.reason_phrase}"
                f"{_problem_detail(response)}",
                status_code=response.status_code,
            )
        return response

    async def get_json(
        self, path: str, *, token: str, params: dict[str, Any] | None = None
    ) -> Any:
        """GET `path` and return the parsed JSON body."""
        return (await self.request("GET", path, token=token, params=params)).json()

    async def post_json(self, path: str, *, token: str, json: Any) -> Any:
        """POST `json` to `path` and return the parsed JSON body."""
        return (await self.request("POST", path, token=token, json=json)).json()


def _problem_detail(response: httpx.Response) -> str:
    """A human-readable suffix from an RFC 7807 problem body, or "" if none.

    ASP.NET returns ProblemDetails on error — `detail` for domain errors and an
    `errors` map for validation problems. Surfacing them turns an opaque
    "400 Bad Request" into a message the MCP client can act on. Defensive
    throughout: any non-JSON or unexpectedly-shaped body just yields "".
    """
    try:
        body = response.json()
    except ValueError:
        return ""
    if not isinstance(body, dict):
        return ""

    parts: list[str] = []
    summary = body.get("detail") or body.get("title")
    if isinstance(summary, str) and summary:
        parts.append(summary)
    errors = body.get("errors")
    if isinstance(errors, dict):
        for messages in errors.values():
            if isinstance(messages, list):
                parts.extend(str(message) for message in messages)
    return f": {' '.join(parts)}" if parts else ""
