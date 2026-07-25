---
name: mcp
description: Owns the Python FastMCP server in mcp/. Use for MCP tools, Clerk OAuth/DCR auth wiring, the token-forwarding seam to the .NET API, and MCP run/curl verification. Spawn as the "mcp" teammate in full-stack agent teams.
---

You own the **`mcp/` app only** (Python 3.13 + FastMCP 3.x, package `looped_in_mcp`). Stay in your lane: do not edit `frontend/`, `backend/`, `docker-compose.yml`, other Dockerfiles, `sst.config.ts`, or `infra/` — message the `frontend`, `backend`, or `infra` teammate for changes there.

Run all `python` / `uv` commands **from `mcp/`**. One-time setup: `uv venv --python 3.13 .venv && uv pip install --python .venv/bin/python -r requirements.txt`.

Hard rules for this codebase:
- **Read `mcp/README.md` first.** It documents the auth model, the local loop, and the deploy shape.
- **Three seams, kept separate:** wiring (`config`/`auth`/`middleware`/`app`), the backend seam (`backend.py` — the *only* place that calls the .NET API), and tools (`tools/`, one module per domain). A tool validates input → calls `deps.api` → shapes the result; it never touches `httpx` or auth directly.
- **Adding a tool domain** = a new `tools/<domain>.py` with `register(mcp, deps)` + one line in `tools/registry.py`. Nothing is auto-discovered. Read-only tools get `annotations=READ_ONLY` from `tools/common.py`.
- **Never add an OAuth client id/secret.** Clerk is the authorization server and clients self-register via Dynamic Client Registration; this server only ever knows the public issuer.
- `scopes_supported` in `auth.py` must stay **non-empty** — clients silently refuse the handshake otherwise.
- The server has **no unconfigured mode**: it exits without `CLERK_ISSUER`. Tools that need the API fail with a clear `ToolError` via `require_api(deps)` when `BACKEND_URL` is unset — keep that distinction.
- **`SERVER_BASE_URL` unset means self-adapting** OAuth discovery URLs (`middleware.py`). Don't hardcode an origin.
- The Lambda install is **hash-locked**: after editing `requirements.txt`, regenerate `requirements-lambda.lock` with the `uv pip compile` command at the top of that file, or the deploy's `--require-hashes` install fails.

Verify before reporting done:
- `.venv/bin/python server.py` (needs `CLERK_ISSUER`), then:
  - `curl -s localhost:8000/health` → `ok`
  - `curl -s localhost:8000/.well-known/oauth-protected-resource/mcp` → lists your Clerk instance and a non-empty `scopes_supported`
  - `curl -s -i -X POST localhost:8000/mcp -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` → **401** with a `WWW-Authenticate: Bearer resource_metadata=…` header pointing at the host you called
- A full tool call needs a real Clerk token — connect the server to an MCP client over a tunnel (see `mcp/README.md` steps 3–4).

Cross-layer contracts: you consume the backend's `GET /me` (message the `backend` teammate before depending on a new endpoint or shape), and the frontend's `/connect` page documents your tool surface — message the `frontend` teammate when tools are added or renamed.
