---
name: prime-context
description: Prime a session with repo, git, and structural context before non-trivial work on Looped In. Use at the start of an implementation, debugging, or review task to capture branch/diff state, read the key docs, map the structure (frontend Next.js / backend .NET / Compose), and state a verification plan before editing.
---

# Prime Context

Run this before any non-trivial implementation, debugging, or review work so edits start from an accurate picture of the repo. Adapted to Looped In's layout — a root holding the Docker Compose stack and `.claude/skills/`, with the apps in `frontend/` (Next.js) and `backend/` (.NET 10 Web API).

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
- **Before writing any Next.js code**, read the relevant guide in `frontend/node_modules/next/dist/docs/` — Next 16 changed conventions from what's in training data (see `frontend/AGENTS.md`).
- For backend work, read `backend/LoopedIn.Api/Program.cs` (minimal-API endpoint map) and `backend/LoopedIn.Api/LoopedIn.Api.csproj` (target framework / packages) before editing.
- When the task spans both services or the container setup, read `docker-compose.yml` and the per-app `Dockerfile`s.

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
  - frontend↔backend wiring uses `BACKEND_URL` (server-side, Compose network) vs `NEXT_PUBLIC_API_URL` (browser, host port)
  - no Tailwind — style via CSS Modules + `globals.css`
- a verification plan with the narrowest applicable check first

## Verify

There is **no test suite** in either app. Verification means:

**Frontend** (from `frontend/`):
- `npm run lint` — code-quality checks
- `npm run build` — confirms the production build + TypeScript typecheck are clean
- `npm run dev` — view in the browser to confirm behavior

**Backend** (from `backend/`):
- `dotnet build LoopedIn.slnx` — confirms it compiles
- `dotnet run --project LoopedIn.Api --launch-profile http` then `curl http://localhost:5114/` (and `/weatherforecast`, `/openapi/v1.json`)
- `curl http://localhost:5114/db/ping` — Neon connectivity (`SELECT version()`); needs `DATABASE_URL` in `backend/.env.local`, else returns a 503 "not configured"

**Full stack** (from repo root):
- `docker compose up --build -d`, then curl `http://localhost:5114/` and `http://localhost:3000/`; `docker compose down` to clean up.

Run the narrowest applicable check first (a focused build or curl) before bringing the whole stack up.
