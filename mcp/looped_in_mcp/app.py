"""App factory: assemble Clerk auth + shared deps + all tool modules into the
ASGI app. Kept side-effect-free at import (everything happens inside
`create_app`) so tests can build a server with fake settings and no network.
`server.py` adapts the returned app for local `uvicorn` and Lambda (Mangum).
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastmcp import FastMCP
from starlette.requests import Request
from starlette.responses import PlainTextResponse

from looped_in_mcp.auth import build_auth
from looped_in_mcp.backend import LoopedInApiClient
from looped_in_mcp.config import SENTINEL_ORIGIN, Settings
from looped_in_mcp.deps import Deps
from looped_in_mcp.middleware import PublicUrlRewriteMiddleware
from looped_in_mcp.tools.registry import TOOL_MODULES


def create_app(settings: Settings | None = None):
    """Build the Looped In MCP ASGI app. Returns the wrapped ASGI app."""
    settings = settings or Settings.from_env()
    deps = Deps()

    @asynccontextmanager
    async def app_lifespan(_server: FastMCP):
        # Open the shared backend client once per container (Mangum runs the
        # lifespan on cold start; uvicorn on startup). Skipped when no backend is
        # configured — whoami and the auth handshake still work without it.
        if settings.backend_url:
            deps.api = LoopedInApiClient(settings.backend_url)
        try:
            yield
        finally:
            if deps.api is not None:
                await deps.api.aclose()
                deps.api = None

    mcp = FastMCP("looped-in-mcp", auth=build_auth(settings), lifespan=app_lifespan)

    # Health check: NOT behind auth (FastMCP exempts custom routes by design).
    @mcp.custom_route("/health", methods=["GET"])
    async def health(_request: Request) -> PlainTextResponse:
        return PlainTextResponse("ok", status_code=200)

    # Each module's register() attaches its tools to the shared mcp instance.
    for module in TOOL_MODULES:
        module.register(mcp, deps)

    # Stateless streamable-HTTP with plain-JSON responses: each request is
    # self-contained (no server-side session, no SSE GET stream) — what a
    # serverless / multi-instance deploy needs. `GET /mcp` is 405 by design.
    app = mcp.http_app(stateless_http=True, json_response=True)
    if settings.rewrite_public_url:
        app = PublicUrlRewriteMiddleware(
            app, SENTINEL_ORIGIN, settings.allowed_public_hosts
        )
    return app
