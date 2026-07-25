"""Looped In MCP server — entrypoints only.

The server's code lives in the `looped_in_mcp` package: `config` (env), `auth`
(Clerk), `middleware` (the self-adapting public-URL rewrite), `backend` (the
Looped In API seam), `tools/` (the tool modules), and `app.create_app` (which
assembles them). This file is the thin adapter that turns that ASGI app into the
two ways it runs:

  * local dev / docker compose — `python server.py` serves it over HTTP (uvicorn);
  * AWS Lambda behind API Gateway — `handler` below (Mangum), referenced as
    `server.handler` in infra/services/mcp.ts.

See looped_in_mcp/app.py for how the app is assembled, and mcp/README.md for the
auth model and deploy notes.
"""

from __future__ import annotations

from mangum import Mangum

from looped_in_mcp.app import create_app
from looped_in_mcp.config import Settings

settings = Settings.from_env()
app = create_app(settings)

# AWS Lambda entrypoint (zip package, runtime python3.13). Mangum adapts the ASGI
# app to the API Gateway HTTP API payload-format-2.0 event/response shape and runs
# the app's lifespan on cold start. Referenced as `server.handler` by the Lambda's
# `handler` property in infra/services/mcp.ts.
handler = Mangum(app, lifespan="auto")


if __name__ == "__main__":
    # Local dev (and docker compose): serve the same wrapped app over HTTP.
    # The MCP endpoint is served at {base_url}/mcp.
    import uvicorn

    uvicorn.run(app, host=settings.host, port=settings.port)
