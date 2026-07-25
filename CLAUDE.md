# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Looped In — an early-stage full-stack application. Today it is a scaffold: a **Next.js** frontend and a **.NET 10** Web API, wired together as a **Docker Compose** stack. (Replace this paragraph with the product description as the app takes shape.)

## Layout

The repo root holds the Compose stack and `.claude/skills/`. The **frontend is in `frontend/`** — run all `npm` commands from there. The **backend is in `backend/`** — run all `dotnet` commands from there.

```
frontend/            ← Next.js 16 App Router app, TypeScript (cd here for npm)
backend/             ← .NET 10 minimal Web API — LoopedIn.Api + LoopedIn.slnx (cd here for dotnet)
docker-compose.yml   ← orchestrates frontend (3000) + backend (5114→8080) on a shared network
.claude/skills/      ← prime-context (session priming) + future reference skills
```

Each app carries its own container setup: `frontend/Dockerfile` + `frontend/.dockerignore`, `backend/Dockerfile` + `backend/.dockerignore`. `.gitignore`s live per-app (`frontend/.gitignore`, `backend/.gitignore`); there is no root-level Node/.NET ignore.

**The services now talk over Clerk-authenticated calls.** The frontend `/me` page (`app/me/page.tsx`) makes a **server-side** call to the backend's protected `GET /me` using `BACKEND_URL` (the Compose network); `NEXT_PUBLIC_API_URL` remains available for browser-side calls via the host port. See **Authentication (Clerk)** below.

## Commands

**Frontend** — from `frontend/`:

| Command | What |
| --- | --- |
| `npm run dev` | Next dev server (Turbopack) on http://localhost:3000 |
| `npm run build` | Production build (also runs `tsc` typecheck) |
| `npm run start` | Serve the production build |
| `npm run lint` | ESLint (flat config) |

**Backend** — from `backend/`:

| Command | What |
| --- | --- |
| `dotnet run --project LoopedIn.Api` | Run the API (https `7191` + http `5114`; default profile is **https**) |
| `dotnet run --project LoopedIn.Api --launch-profile http` | Run http-only (no dev cert needed) |
| `dotnet build LoopedIn.slnx` | Build the solution |
| `dotnet dev-certs https --trust` | Trust the local HTTPS cert (once, for the https profile) |

**Docker Compose** — from the repo root:

| Command | What |
| --- | --- |
| `docker compose up --build` | Build + run both services |
| `docker compose up -d` | Start detached |
| `docker compose logs -f` | Tail logs |
| `docker compose down` | Stop and remove |

There is **no test suite** in either app — verify changes by building and running (see the `prime-context` skill).

## Stack

- **Frontend:** Next.js **16.2.9** + React **19**, TypeScript, **App Router** (`app/`), no `src/` dir, **no Tailwind**, import alias `@/*`. `next.config.ts` sets `output: "standalone"` so the Docker image ships a trimmed `node_modules` + `server.js`. Auth via **Clerk** (`@clerk/nextjs`) — see Authentication below.
- **Backend:** .NET **10** (`net10.0`) **minimal API** in `backend/LoopedIn.Api/Program.cs` (`GET /` hello + `GET /weatherforecast`). OpenAPI via `Microsoft.AspNetCore.OpenApi` (no Swashbuckle); `Nullable` + `ImplicitUsings` enabled. Requires the **.NET 10 SDK** (installed here via Homebrew → `/opt/homebrew/bin/dotnet`). Protected endpoints are guarded by **Clerk JWT Bearer** auth — see Authentication below.
- **Containers:** multi-stage Dockerfiles, both final images run **non-root**. Backend listens on `8080` inside the container (`ASPNETCORE_HTTP_PORTS`); host maps it to `5114`.

## Database (Neon Postgres)

The backend talks to **Neon** (serverless Postgres) via **Npgsql** (a pooled `NpgsqlDataSource`). The connection string comes from the `DATABASE_URL` environment variable: locally it's loaded from a gitignored **`backend/.env.local`** (via `DotNetEnv`), and in Compose it's passed through `env_file` (optional, so `up` still works without it). `backend/.env.local.example` is the committed template — copy it to `.env.local` and paste your Neon URL.

- `DATABASE_URL` accepts **either** Neon's `postgresql://…` URL **or** a native Npgsql key/value string; `DbBootstrap.ToNpgsqlConnectionString` in `Program.cs` normalizes the URL form (and honors `?sslmode=`, defaulting to `Require` since Neon requires TLS).
- **`GET /db/ping`** is the connectivity check: runs `SELECT version(), now()` → `{ connected, version, serverTime }`. It returns **503** with a clear message when `DATABASE_URL` is unset, so the rest of the API runs fine with no DB configured.

## Authentication (Clerk)

Both apps use **Clerk**. The frontend was scaffolded by the Clerk CLI (`clerk init`, linked to app `ch-ai-platform` / `app_3Fmjg3lnavgRFblK0ccF518EYjj`); the backend validates Clerk-issued session JWTs. Like the DB wiring, the backend **no-ops gracefully** when Clerk is unconfigured — the app still boots, but protected endpoints reject every request with **401**.

**Frontend** (`@clerk/nextjs`):
- `ClerkProvider` wraps the body in `app/layout.tsx` (**inside `<body>`**, not `<html>`). The header shows sign-in/sign-up controls when signed out and a `UserButton` when signed in (`Show` / `SignInButton` / `SignUpButton` / `UserButton`), plus a "My API identity" link to `/me`.
- **`proxy.ts`** (Next 16 uses `proxy.ts`, **not** `middleware.ts`) protects all non-public routes — so `/` redirects to `/sign-in` when signed out; only the `app/sign-in` and `app/sign-up` routes are public. Its `config.matcher` includes `'/__clerk/:path*'` after `'/(api|trpc)(.*)'`.
- Publishable/secret keys live in gitignored **`frontend/.env.local`** (written by `clerk init`). **Never expose `CLERK_SECRET_KEY` client-side.** `auth()` is **async** — always `await auth()`; import it from `@clerk/nextjs/server` in server code.
- Dynamic auth UI is wrapped in `<Suspense>` so it stays compatible with `cacheComponents: true`.

**Backend** (`Microsoft.AspNetCore.Authentication.JwtBearer`):
- Configured in `Infrastructure/Authentication/AuthenticationServiceCollectionExtensions.cs` (`AddClerkAuthentication`), wired in `Program.cs` with `UseAuthentication()` / `UseAuthorization()`.
- Reads **`Clerk:Authority`** (env `Clerk__Authority`) — the Clerk **Frontend API URL** (e.g. `https://<slug>.clerk.accounts.dev`); JWKS/OIDC discovery is automatic. Optional **`Clerk:AuthorizedParties`** (comma-separated) validates the token's `azp` claim. Set these in `backend/.env.local` (see `.env.local.example`); find the Frontend API URL in **Clerk Dashboard → API Keys**.

**Endpoints:**
- **`GET /auth/ping`** (public) — connectivity check mirroring `/db/ping`: reuses the JwtBearer handler's own `ConfigurationManager` to fetch Clerk's OIDC discovery → `{ configured, authority, issuer, jwksUri, signingKeys }`; **503** when `Clerk:Authority` is unset.
- **`GET /me`** (protected, `.RequireAuthorization()`) — returns `{ userId, email, claims }` from the validated token; **401** without a valid bearer. `/`, `/db/ping`, `/weatherforecast` stay public.

**End-to-end:** the frontend `/me` page reads the Clerk token server-side (`await (await auth()).getToken()`) and calls the backend `GET /me` over `BACKEND_URL` — a server-side call, so no CORS and the token never reaches the browser. It's the smoke test for the whole trust chain.

## Agent teams (Claude Code)

This repo is set up for [agent teams](https://code.claude.com/docs/en/agent-teams) — `.claude/settings.json` enables `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`. Teams shine here because the work splits cleanly along the `frontend/` ↔ `backend/` ↔ infra boundary, so teammates own non-overlapping files and don't step on each other.

**Standard full-stack team** — three project subagents in `.claude/agents/` double as teammate roles. Spawn them by name, e.g.:

> Spawn three teammates for this change: a **frontend** teammate, a **backend** teammate, and an **infra** teammate. Frontend owns `frontend/`, backend owns `backend/`, infra owns Compose/Dockerfiles/SST. Have them coordinate on the `/me` contract.

| Role (`.claude/agents/`) | Owns | Don't touch |
| --- | --- | --- |
| `frontend` | `frontend/` (Next 16 App Router, Clerk UI, Cache Components) | backend, infra |
| `backend`  | `backend/LoopedIn.Api` (endpoints, Clerk JWT, Neon/Npgsql) | frontend, infra |
| `infra`    | `docker-compose.yml`, Dockerfiles, `sst.config.ts`, OpenNext, env wiring | app source |

**What teammates do and don't inherit** (per the docs):
- They **read `CLAUDE.md`** (this file + `frontend/CLAUDE.md`) but **not** the lead's conversation history — put task-specific context in the spawn prompt.
- A subagent definition's `tools` and `model` apply to a teammate, and its body is appended to the teammate's system prompt — but its `skills` and `mcpServers` frontmatter are **ignored** for teammates. Skills/MCP still load from project + user settings, so each role's body **names the skills to invoke** (`next-dev-loop`, `dotnet-skills`, etc.).
- Teammates inherit the **lead's permissions**. The allowlist in `.claude/settings.json` pre-approves the dev loop (npm lint/build/dev, `dotnet *`, `docker compose *`, localhost curl); deploy/remove are **denied** so no teammate can ship to AWS — deploys go through the `deploy` skill deliberately.
- Don't pre-author `~/.claude/teams/…` — that team/task state is generated per session and overwritten.

**File-conflict rule:** two teammates editing the same file overwrite each other. The role boundaries above keep lanes separate; when a change crosses a boundary, the owner messages the other teammate rather than reaching across.

Split-pane display (tmux / iTerm2) and the default teammate model are per-machine preferences — set `teammateMode` and **Default teammate model** in your **user** `~/.claude/settings.json` / `/config`, not in this repo.

## Conventions & gotchas

- **Next.js 16 is not the Next.js in your training data.** `frontend/AGENTS.md` (loaded via `frontend/CLAUDE.md`) warns that APIs/conventions changed. **Read the relevant guide in `frontend/node_modules/next/dist/docs/` before writing Next code** — don't rely on memory for App Router/metadata/config conventions.
- **.NET 10 uses the new `.slnx` solution format** (XML), not `.sln`. The solution is `backend/LoopedIn.slnx`; reference it (not a `.sln`) in `dotnet sln` / `dotnet build` commands.
- **OpenAPI is Development-only:** `app.MapOpenApi()` runs only when `ASPNETCORE_ENVIRONMENT=Development`. The doc is served at `/openapi/v1.json` (Compose sets the env to Development, so it's available at http://localhost:5114/openapi/v1.json).
- **Container HTTPS warning is harmless:** the backend keeps `app.UseHttpsRedirection()`, so in the HTTP-only container it logs `Failed to determine the https port for redirect` once at startup, then serves HTTP normally. (Guard the line if you want it silent.)
- **Tailwind is not installed** — style with the existing CSS Modules (`app/page.module.css`) and `app/globals.css`.
- **`.env.local` loads before the host is built:** `DbBootstrap.LoadDotEnvLocal` runs **before** `WebApplication.CreateBuilder` in `Program.cs`, so `.env.local` values land in the process environment before the configuration provider snapshots them. Anything read via `IConfiguration` (e.g. `Clerk:Authority`) depends on this ordering; `DATABASE_URL` is read via `Environment.GetEnvironmentVariable` directly so it's order-independent, but keep the load first.
