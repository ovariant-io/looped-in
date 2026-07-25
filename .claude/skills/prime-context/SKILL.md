---
name: prime-context
description: Prime a session with repo, git, and structural context before non-trivial work on Looped In. Use at the start of an implementation, debugging, or review task to capture branch/diff state, read the key docs, map the structure (frontend Next.js / backend .NET / mcp Python / Compose), and state a verification plan before editing.
---

# Prime Context

Run this before any non-trivial implementation, debugging, or review work so edits start from an accurate picture of the repo. Adapted to Looped In's layout — a root holding the Docker Compose stack and `.claude/skills/`, with the apps in `frontend/` (Next.js), `backend/` (.NET 10 Web API), and `mcp/` (Python FastMCP server).

## Gather

- Read `CLAUDE.md` at the repo root first (project instructions override defaults). The root `README.md` is still a one-line placeholder; `frontend/README.md` is the create-next-app default.
- Capture git context up front:
  - `git status --short --branch`
  - current branch or detached HEAD
  - `git worktree list` (when relevant)
  - `git log --oneline -5`
- Inspect local changes / recent diffs relevant to the task before editing.
- Map the current structure for the area you're touching:
  - frontend: `git ls-files frontend` or `tree -L 2 frontend/app` (App Router pages/layouts live in `frontend/app/`).
  - backend: `git ls-files backend` — the API is `backend/LoopedIn.Api/` (`Program.cs`, `LoopedIn.Api.csproj`); the solution is `backend/LoopedIn.slnx`.
  - mcp: `git ls-files mcp` — the server is `mcp/looped_in_mcp/` with `server.py` as the entrypoint; tools live in `tools/` and are listed in `tools/registry.py`.
- **Before writing any Next.js code**, read the relevant guide in `frontend/node_modules/next/dist/docs/` — Next 16 changed conventions from what's in training data (see `frontend/AGENTS.md`).
- For backend work, read `backend/LoopedIn.Api/Program.cs` (minimal-API endpoint map) and `backend/LoopedIn.Api/LoopedIn.Api.csproj` (target framework / packages) before editing. Document routes live in `Endpoints/DocumentEndpoints.cs` with the S3 seam in `Infrastructure/Storage/`.
- For MCP work, read `mcp/README.md` first (auth model, layout, deploy shape), then `looped_in_mcp/app.py` and `tools/registry.py`.
- When the task spans services or the container setup, read `docker-compose.yml` and the per-app `Dockerfile`s.

## Report

Before making edits or stating findings, report:

- repo state and branch / worktree status
- recent change context (what the dirty files and last commits are doing)
- files / docs reviewed
- task-relevant modules or directories (which `frontend/app/` routes, which endpoints in `Program.cs`, Compose services, etc.)
- constraints identified:
  - Next.js **16** — consult `frontend/node_modules/next/dist/docs/`, don't rely on memory
  - .NET **10** with the new **`.slnx`** solution format (not `.sln`)
  - OpenAPI is **Development-only** (`/openapi/v1.json`); containers run HTTP-only
  - frontend↔backend wiring uses `BACKEND_URL` (server-side, Compose network) vs `NEXT_PUBLIC_API_URL` (browser, host port); `MCP_URL` is runtime-only (not `NEXT_PUBLIC_`)
  - no Tailwind — style via CSS Modules + `globals.css`
  - the MCP server needs **Python 3.13** and **exits without `CLERK_ISSUER`**; its Compose service is behind the `mcp` profile
- a verification plan with the narrowest applicable check first

## Verify

There is **no test suite** in any app. Verification means:

**Frontend** (from `frontend/`):
- `npm run lint` — code-quality checks
- `npm run build` — confirms the production build + TypeScript typecheck are clean
- `npm run dev` — view in the browser to confirm behavior

**Backend** (from `backend/`):
- `dotnet build LoopedIn.slnx` — confirms it compiles
- `dotnet run --project LoopedIn.Api --launch-profile http` then `curl http://localhost:5114/` (and `/openapi/v1.json`)
- `curl http://localhost:5114/db/ping` — Neon connectivity (`SELECT version()`); needs `DATABASE_URL` in `backend/.env.local`, else returns a 503 "not configured"
- `curl http://localhost:5114/documents/ping` — S3 document storage; needs `Documents__Bucket` (and a resolvable `AWS_REGION`) in `backend/.env.local`, else returns a 503 naming what's missing

**MCP** (from `mcp/`, after `uv venv --python 3.13 .venv && uv pip install --python .venv/bin/python -r requirements.txt`):
- `.venv/bin/python server.py` (needs `CLERK_ISSUER`), then `curl http://localhost:8000/health` → `ok`
- `curl http://localhost:8000/.well-known/oauth-protected-resource/mcp` — the OAuth discovery doc; must list your Clerk instance and a non-empty `scopes_supported`
- an unauthenticated `POST /mcp` must return **401** with a `WWW-Authenticate` challenge naming the host you called

**Infra** (from repo root):
- `npm run infra:check` — typechecks `infra/` + `sst.config.ts`, no AWS access

**Full stack** (from repo root):
- `docker compose up --build -d`, then curl `http://localhost:5114/` and `http://localhost:3000/`; add `--profile mcp` and curl `http://localhost:8000/health` for the MCP server; `docker compose down` to clean up.

Run the narrowest applicable check first (a focused build or curl) before bringing the whole stack up.
