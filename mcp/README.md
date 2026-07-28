# Looped In MCP server

A [FastMCP](https://gofastmcp.com) server that authenticates callers with
**Clerk** via OAuth **Dynamic Client Registration (DCR)**, so Claude (and any
other MCP client) can act against Looped In as the signed-in user.

The auth chain is complete and proven end to end. The tool surface starts with
two identity tools —

- **`whoami`** — echoes the verified Clerk identity (`sub`, `email`, `iss`) from
  the caller's token. Proves the near half of the chain: MCP client → Clerk →
  this server.
- **`my_api_identity`** — forwards the caller's token to the .NET API's protected
  `GET /me`, which validates it independently against Clerk's JWKS, and returns
  what the API saw. Proves the far half: this server → the Looped In API. It is
  the MCP counterpart of the frontend's `/me` page.

— plus **client-pipeline CRUD tools** (`tools/clients.py`), mapping 1:1 onto
the API surface under `/clients`. The list is shared team data, so these answer
"what is the state of *our* pipeline" — and change it:

- **Readers:** `list_clients` — paged summaries with `search` / `industry` /
  `status` filters (`status` is a closed set in the tool schema, so a bad value
  is refused rather than silently unfiltered as the API's `?status=` would be);
  `get_client` — one client in full, including contacts and the prose and
  lifecycle fields the summaries omit; `get_client_status_history` — the
  append-only transition audit trail; `list_client_interactions` — the
  per-client outreach log.
- **Writers:** `create_client` / `update_client` / `delete_client`,
  `change_client_status` (the only writer of status — a transition is an
  event), `add_client_contact` / `update_client_contact` /
  `delete_client_contact`, and `add_client_interaction` /
  `update_client_interaction` / `delete_client_interaction`.

— plus **EDM campaign tools** (`tools/campaigns.py`), mapping 1:1 onto
`/campaigns`: a campaign is a drafting brief plus one message per client, and
nothing here sends email — drafting is the agent's job, sending is the human's,
the tools record the outcome:

- **Readers:** `list_campaigns` — paged summaries carrying per-state message
  counts (a campaign has no status of its own); `get_campaign` — the brief,
  every drafted message with full bodies, and the `contactOptions` a recipient
  can be chosen from.
- **Writers:** `create_campaign` / `update_campaign` / `delete_campaign`, and
  `add_campaign_message` / `update_campaign_message` /
  `delete_campaign_message` (one draft per client per campaign — a 409 means
  edit the existing one), plus `set_campaign_message_state` (the only writer of
  state — entering `sent` stamps `sentAt` and appends an `email` interaction to
  the client's outreach log, so agents must not also log the touch by hand).

The write policy is deliberate, not inherited from the API. Every update
requires `expected_version` from a fresh read, so a concurrent edit surfaces as
a 409 instead of an overwrite. The API's PATCH is a full replacement where null
*clears* a field — right for a form resending a row it just loaded, hostile to
an agent that omits what it didn't mean to change — so the update tools merge:
they re-read the row, keep every unmentioned field, and null out only fields
named in `clear`. Deletes are real deletes; their schemas say so
(`destructiveHint`) and their docstrings direct the agent to confirm with the
user first. An unauthenticated `GET /health` rounds things out.

Adding a domain is a new module under `looped_in_mcp/tools/` and one line in
`registry.py`; tools stay thin (validate input → call `deps.api` → shape the
result) and never touch `httpx` or auth directly.

## How the auth works

- **Clerk** is the OAuth **authorization server**. With DCR enabled, MCP clients
  (Claude Desktop, Cursor, …) register themselves with Clerk automatically and
  run the OAuth flow — this server never holds a client id/secret.
- **This server** is the OAuth **resource server**. It advertises Clerk as its
  authorization server and validates the Clerk-issued JWT on every request.

The discovery chain a client follows:

```
client → POST /mcp                                      → 401 + WWW-Authenticate: resource_metadata=…
client → GET /.well-known/oauth-protected-resource/mcp  → { authorization_servers: [Clerk], scopes_supported: […] }
client → GET {Clerk}/.well-known/oauth-authorization-server → authorize/token/registration endpoints
client → DCR register + OAuth (browser login + consent) → access token
client → POST /mcp  (Bearer <token>)                    → JWTVerifier validates vs Clerk JWKS ✓
```

The wiring (`RemoteAuthProvider` + `JWTVerifier`) is the canonical FastMCP setup
for DCR-capable identity providers. Because `CLERK_ISSUER` is the same value the
backend uses as `Clerk__Authority`, a token minted for one is understood by the
other — which is what lets `my_api_identity` forward it straight through.

## Prerequisites

- **Python 3.13** — matches the Lambda runtime (`python3.13` / `uv` both work).
- A **Clerk** instance (the same one the rest of Looped In uses).
- A tunnel for a local test with a real client: **ngrok** or **cloudflared**
  (custom connectors want an HTTPS URL).

## 1. Configure Clerk (one-time, manual — Dashboard)

DCR is **off by default** and creates a public client-registration endpoint, so
Clerk gates it behind a toggle.

1. Clerk Dashboard → **OAuth applications** (<https://dashboard.clerk.com/~/oauth-applications>).
2. Toggle on **Dynamic client registration**. (When DCR is on, the OAuth
   **consent screen is auto-enforced** and can't be disabled — that's expected.)
3. Grab your **Frontend API URL** from **API Keys** (e.g.
   `https://your-slug.clerk.accounts.dev`) — this is `CLERK_ISSUER` below, and
   it's the same value the backend uses as `Clerk__Authority`.

> Clerk allows loopback redirect URIs (`http://localhost/callback`,
> `http://127.0.0.1/callback`, port-agnostic), which is what desktop clients use
> for the OAuth callback.

## 2. Run it locally

Either a venv or the Compose profile — both serve `http://localhost:8000/mcp`.

```bash
cd mcp
cp .env.example .env.local          # then edit it (see below)

uv venv --python 3.13 .venv         # or: python3.13 -m venv .venv
uv pip install --python .venv/bin/python -r requirements.txt

.venv/bin/python server.py          # serves http://0.0.0.0:8000/mcp
```

```bash
# …or from the repo root, in the Compose stack (backend included):
docker compose --profile mcp up --build
```

`.env.local` (gitignored — see `.env.example` for the full template):

```
CLERK_ISSUER=https://your-slug.clerk.accounts.dev
BACKEND_URL=http://localhost:5114                      # http://backend:8080 under Compose
SERVER_BASE_URL=https://<your-tunnel>.ngrok-free.app   # set after step 3
```

`SERVER_BASE_URL` **must be the URL the client reaches the server at** — the
OAuth Protected Resource Metadata is generated from it. For a tunneled local
test, that's the tunnel URL (not `http://localhost`). Leave it unset and the
server self-adapts to whatever host each request arrives on; a **blank** value
(`SERVER_BASE_URL=`) counts as unset, so it and deleting the line are equivalent.

When self-adapting, the host is taken from the request's `Host` header, so it is
validated first: the scheme must be `http`/`https` and the host must match the
RFC 3986 reg-name shape (letters, digits, dot, hyphen, optional `:port`). A
request failing either is served with the sentinel origin left in place rather
than reflecting an attacker-chosen host into the discovery documents. Set
**`ALLOWED_PUBLIC_HOSTS`** (comma-separated) to narrow it to an explicit list
once you know the hostname — worth doing behind a tunnel or a custom domain.

Quick sanity checks (before involving Clerk or a real client):

```bash
curl -s http://localhost:8000/health                                   # → ok
curl -s http://localhost:8000/.well-known/oauth-protected-resource/mcp # → lists Clerk as authorization_servers
curl -s -i -X POST http://localhost:8000/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'                  # → 401 + WWW-Authenticate challenge
```

## 3. Expose it over HTTPS

```bash
ngrok http 8000
#   → https://abc123.ngrok-free.app
```

Set `SERVER_BASE_URL` in `.env.local` to that HTTPS URL and **restart**
`server.py` so the metadata advertises the tunnel URL.

## 4. Add it to Claude Desktop and test

1. Claude Desktop → your profile → **Settings** → **Connectors** →
   **Add custom connector**.
2. URL: `https://abc123.ngrok-free.app/mcp` (the tunnel URL + `/mcp`). Leave the
   OAuth client id/secret blank — DCR fills them in.
3. Claude opens a browser → **Clerk sign-in** → **Clerk consent screen** →
   **Allow**.
4. In a chat, invoke **`whoami`**. A result with your `sub` / `email` / `iss`
   means the Clerk-DCR auth chain works. Then invoke **`my_api_identity`** — a
   result means the server can act against the .NET API on your behalf. ✅

The deployed app shows the same instructions at **`/connect`**, with the live
connection link filled in — a per-client guide (Claude Desktop first) that also
hands out a copyable **assistant system prompt** for a Claude project, teaching
the assistant this server's tool surface. That prompt lives in
`frontend/app/(app)/connect/assistant-prompt.ts`; keep it in step when the tool
surface changes.

## Deploy to AWS (SST)

In the cloud this runs as a **Python 3.13 Lambda** (zip, arm64, behind
[Mangum](https://mangum.io)) fronted by its **own API Gateway HTTP API** — the
same scale-to-zero, no-VPC shape as the .NET API, and like it, the function has
**no Function URL**. It's wired in `infra/services/mcp.ts` +
`infra/services/mcp-gateway.ts` and ships with `npm run deploy:<env>` (see
[`DEPLOY.md`](../DEPLOY.md)); the deploy host needs **`python3.13` on `PATH`**.

Deployment installs the hash-locked `requirements-lambda.lock` for Python 3.13
ARM64 regardless of host OS (`infra/artifacts/python-lambda.ts`); local
development uses the human-maintained ranges in `requirements.txt`. After editing
`requirements.txt`, regenerate the lock:

```bash
uv pip compile mcp/requirements.txt --generate-hashes \
  --python-version 3.13 --python-platform aarch64-manylinux2014 \
  -o mcp/requirements-lambda.lock
```

Two things differ from the local/tunnel flow above:

- **You don't set `SERVER_BASE_URL`.** The gateway endpoint is generated by AWS
  and a Lambda can't reference its own URL in its env without a circular
  dependency, so the server **self-adapts** its OAuth discovery URLs to the URL
  it's actually reached at (rewriting the `WWW-Authenticate` challenge and the
  protected-resource metadata per request). Setting `SERVER_BASE_URL` pins a
  fixed value and turns the rewriting off — only do that behind a stable custom
  domain.
- **`CLERK_ISSUER` comes from the existing `ClerkAuthority` SST secret** — no new
  secret to manage.

After deploy, the `mcp` stack output is the connector URL (already ending in
`/mcp`), and the app's `/connect` page shows the same value.

> The deployed server runs **stateless** (each request is self-contained, no SSE
> session) so it's correct on Lambda. A side effect: `GET /mcp` returns **405** —
> MCP clients POST JSON-RPC, so this is expected, not a fault.

## Troubleshooting

- **Handshake silently fails / no login prompt** — `scopes_supported` must be
  non-empty; clients refuse an empty list (it's hardcoded to
  `["profile","email","offline_access"]` in `auth.py`).
- **`SERVER_BASE_URL` mismatch** — if it doesn't match the URL the client
  connects to, the protected-resource metadata points at the wrong host and
  discovery breaks. Restart after changing it.
- **401 after consent** — the token issuer must equal `CLERK_ISSUER`. Confirm the
  connector points at the same Clerk instance whose Frontend API URL you set.
- **DCR registration rejected by Clerk** — the **Dynamic client registration**
  toggle isn't on, or you're pointing at the wrong Clerk instance.
- **`my_api_identity` says the API isn't configured** — `BACKEND_URL` is unset.
  `whoami` still works without it.

## Layout

The code is split along three seams so it stays maintainable as tools accrue —
**infra/wiring**, the **backend seam** (the one place that calls the Looped In
API), and **tools** (one module per domain).

| Path | What |
| --- | --- |
| `server.py` | Thin entrypoints only: builds the app via `looped_in_mcp.create_app`, then exposes it for local `uvicorn` and Lambda (`handler` via Mangum, `server.handler` in `infra/services/mcp.ts`). |
| `looped_in_mcp/config.py` | `Settings` — parse + validate the env once; loads `.env.local`. |
| `looped_in_mcp/auth.py` | Clerk auth wiring (`RemoteAuthProvider` + `JWTVerifier`). |
| `looped_in_mcp/middleware.py` | `PublicUrlRewriteMiddleware` — self-adapting OAuth discovery URLs. |
| `looped_in_mcp/backend.py` | `LoopedInApiClient` — the **single seam** to the .NET API (token forwarding, RFC 7807 error mapping). |
| `looped_in_mcp/deps.py` | `Deps` — shared resources (the API client) handed to each tool module. |
| `looped_in_mcp/app.py` | `create_app()` — assembles auth + deps + tools + middleware into the ASGI app. |
| `looped_in_mcp/tools/` | One module per tool domain; `registry.py` lists them, `common.py` holds the shared token/client helpers plus the annotation vocabularies (`READ_ONLY`, `ADDITIVE`, `OVERWRITE`, `REMOVAL`). `identity.py` → `whoami` + `my_api_identity`; `clients.py` → the client-pipeline CRUD tools; `campaigns.py` → the EDM campaign-drafting tools. |
| `requirements.txt` | Local dev ranges: `fastmcp` (3.x), `pydantic`, `httpx`, `python-dotenv`, `mangum` (Lambda), `uvicorn` (local). |
| `requirements-lambda.lock` | Hash-locked, platform-pinned install used by the deploy. |
| `Dockerfile` | `python:3.13-slim`, non-root, used by the `mcp` Compose profile. |
| `.env.example` | Template → copy to `.env.local`. |
