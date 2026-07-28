# Plan: read-only Client tools for the MCP server

> **Status: implemented** — `tools/clients.py` is registered and verified per
> the plan below (schema/registration checks + server boot smoke test); the
> authenticated end-to-end pass through a real MCP client remains a manual step.

Give MCP clients a read-only view over everything the API knows about clients —
the list, the detail (with contacts), the status history, and the interaction
log. No mutations in this pass. The point is twofold: immediate value (an agent
can answer "what's the state of our pipeline?" / "when did we last touch X?"),
and establishing the house pattern every future MCP domain module will copy.

## Current state (what this builds on)

The scaffolding for exactly this already exists and needs no changes:

- `looped_in_mcp/backend.py` — `LoopedInApiClient` is the single seam to the
  .NET API: base URL, per-call bearer token, HTTP-error → `ToolError`
  translation (including RFC 7807 `detail`/`errors` extraction). Tools stay
  "validate input → call client → return JSON".
- `looped_in_mcp/tools/common.py` — `caller_token()` (the verified Clerk JWT to
  forward), `require_api(deps)` (clear error when `BACKEND_URL` is unset), and
  the `READ_ONLY` annotations dict.
- `looped_in_mcp/tools/registry.py` — explicit module list; a domain is one
  `tools/<domain>.py` with `register(mcp, deps)`, imported and appended there.
- `tools/identity.py` — the reference implementation (`my_api_identity` already
  forwards the caller's token to a protected API route).

The API's client routes are all behind `RequireAuthorization()` +
`DatabaseGateFilter`, so the forwarded Clerk token and the API's own 503
handling do all the auth/availability work — the MCP side adds nothing.

## API read surface → tools

Four GET endpoints exist (`Endpoints/ClientEndpoints.cs`); map them 1:1. No
composite "overview" tool in this pass — 1:1 keeps error semantics and paging
obvious, and a composite can be layered on later without unwinding anything.

| Tool | API route | Returns |
| --- | --- | --- |
| `list_clients` | `GET /clients?search=&industry=&status=&limit=&offset=` | `{ clients: ClientSummary[], total, limit, offset }` |
| `get_client` | `GET /clients/{id}` | `ClientDetail` incl. `contacts[]` |
| `get_client_status_history` | `GET /clients/{id}/status-history` | `StatusHistoryEntry[]` |
| `list_client_interactions` | `GET /clients/{id}/interactions` | `InteractionSummary[]` |

All four carry `annotations=READ_ONLY`.

### Signatures

```python
def register(mcp: FastMCP, deps: Deps) -> None:

    @mcp.tool(annotations=READ_ONLY)
    async def list_clients(
        search: str | None = None,
        industry: str | None = None,
        status: ClientStatus | None = None,   # Literal — see below
        limit: int | None = None,             # API clamps to [1, 200], default 50
        offset: int | None = None,
    ) -> dict: ...

    @mcp.tool(annotations=READ_ONLY)
    async def get_client(client_id: str) -> dict: ...

    @mcp.tool(annotations=READ_ONLY)
    async def get_client_status_history(client_id: str) -> list: ...

    @mcp.tool(annotations=READ_ONLY)
    async def list_client_interactions(client_id: str) -> list: ...
```

## Decisions

**`status` is a `Literal`, and that makes a fourth mirror site.** The API
deliberately degrades an unrecognised `?status=` to "no filter" — right for a
browser URL, a silent footgun for an agent, which would read unfiltered results
as the filtered answer. Typing the param as
`Literal["lead", "contacted", "in_discussion", "proposal_sent", "active_client", "former_client", "lost", "do_not_contact"]`
puts the closed set in the tool's JSON schema, so a bad value is refused at the
protocol layer with the valid values in hand. Cost: the status list is now
mirrored in **four** places (migration `0002`, `ClientValidation.ClientStatuses`,
frontend `types.ts`, and this module) — update the "three places" note in
`CLAUDE.md` when this lands.

**Validate `client_id` as a UUID before calling.** The API routes constrain
`{id:guid}`, so a non-GUID never reaches the handler — it comes back as a bare
routing 404 with no "Client not found" body. `uuid.UUID(client_id)` in the tool
turns that into an actionable `ToolError` ("not a valid client id") and keeps
the API's 404 meaning exactly one thing: the client doesn't exist.

**Responses pass through as-is.** Return the API's JSON verbatim (camelCase, the
same shapes the frontend consumes: `ClientSummary`, `ClientDetail`,
`StatusHistoryEntry`, `InteractionSummary`). One contract across web UI and MCP;
no MCP-side reshaping to drift. Two field semantics belong in docstrings instead
of code: `owner` is a raw Clerk `sub` (no user directory exists — suggest
`whoami` to resolve "me"), and `version` matters only to future write tools.

**Errors propagate.** `LoopedInApiError` messages already carry method, path,
status, and problem detail; a 404 reads "Client not found." unmodified. No
per-tool try/except.

**Docstrings are the product.** They are what the calling agent reads. Each one
states: the data is a *shared* team pipeline (not per-user), what the statuses
mean as a lifecycle, that `search` matches name-ish fields (`ilike`, literal
`%`/`_` are safe) but **not** `website`/`whatTheyDo`, that the list is paged
(`total`/`limit`/`offset` in the response, max 200 per page) while history and
interactions come back whole, and that `get_client` is the only reader that
includes contacts.

**Only `params` that were provided get sent** — build the query dict from
non-`None` args so the API's own defaulting stays authoritative.

## Files

| File | Change |
| --- | --- |
| `mcp/looped_in_mcp/tools/clients.py` | **New** — the four tools + `ClientStatus` Literal, module docstring stating the shared-data model |
| `mcp/looped_in_mcp/tools/registry.py` | Import `clients`, append to `TOOL_MODULES` |
| `mcp/README.md` | Add the tools to the tool table / overview |
| `CLAUDE.md` (root) | Status mirror count 3 → 4; mention the MCP client tools |

No changes to `backend.py`, `common.py`, `deps.py`, the .NET API, or infra. No
new dependencies, so `requirements-lambda.lock` stays untouched.

## Out of scope (the foundation this sets up)

- **Write tools** (create/update/status-change/log-interaction) — need the
  `expectedVersion` read-modify-write dance and a decision about how much an
  agent may mutate a shared list; deliberately later.
- **Composite/overview tools** (detail + history + interactions in one call) —
  add once real agent usage shows the three-call pattern is common.
- **Documents domain** — same registry pattern, next module.

## Verification (no test suite — build/run/curl)

1. `cd mcp && .venv/bin/python -c "from looped_in_mcp.app import create_app"` —
   import/registration sanity, catches a bad Literal or signature immediately.
2. Run the stack: API via `dotnet run --launch-profile http` (needs
   `DATABASE_URL` in `backend/.env.local`), MCP via `.venv/bin/python server.py`
   with `CLERK_ISSUER` + `BACKEND_URL=http://localhost:5114` in `mcp/.env.local`.
   `curl localhost:8000/health` → `ok`; unauthenticated `POST /mcp` → 401.
3. End-to-end through a real MCP client (the same path that verified
   `my_api_identity`): connect, confirm all four tools list with
   `readOnlyHint: true`, then exercise each — `list_clients` unfiltered, with
   `status="lead"`, with a `search`; `get_client` on a listed id and on a random
   UUID (expect the API's 404); `get_client_status_history` and
   `list_client_interactions` on a client that has entries; a malformed
   `client_id` (expect the tool-side UUID error).
