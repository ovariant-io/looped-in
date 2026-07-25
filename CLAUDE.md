# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Looped In — an early-stage full-stack application. Today it is a scaffold: a **Next.js** frontend, a **.NET 10** Web API, and a **Python FastMCP** server, wired together as a **Docker Compose** stack. (Replace this paragraph with the product description as the app takes shape.)

## Layout

The repo root holds the Compose stack, the **SST infra**, and `.claude/skills/`. The **frontend is in `frontend/`** — run all `npm` commands from there. The **backend is in `backend/`** — run all `dotnet` commands from there. The **MCP server is in `mcp/`** — run all `python`/`uv` commands from there. Root-level `npm` commands (`npm install`, `npm run infra:check`, deploys) belong to the infra, not to any app.

```
frontend/            ← Next.js 16 App Router app, TypeScript (cd here for npm)
backend/             ← .NET 10 minimal Web API — LoopedIn.Api + LoopedIn.slnx (cd here for dotnet)
mcp/                 ← Python 3.13 FastMCP server — looped_in_mcp/ + server.py (cd here for python/uv); see mcp/README.md
docker-compose.yml   ← orchestrates frontend (3000) + backend (5114→8080), plus mcp (8000) behind the `mcp` profile
sst.config.ts        ← thin SST entry point — dynamically imports the modules in infra/
infra/               ← SST resource modules: config/ (stages, secret manifest), services/ (api, gateway, mcp, mcp-gateway, web), storage/ (S3 bucket), operations/, shared/, names.ts; see infra/README.md
scripts/deploy.mjs   ← dotenv → SST secrets → deploy (per-stage: local | test | prod); reads infra/config/secrets.json
DEPLOY.md            ← what gets deployed, secrets table, one-time setup, teardown
.claude/skills/      ← prime-context (session priming) + future reference skills
```

Each app carries its own container setup: `frontend/Dockerfile` + `frontend/.dockerignore`, `backend/Dockerfile` + `backend/.dockerignore`, `mcp/Dockerfile` + `mcp/.dockerignore`. `.gitignore`s live per-app (`frontend/.gitignore`, `backend/.gitignore`, `mcp/.gitignore`) except the root one, which covers the infra (`.sst/`, root `node_modules/`, `.open-next/`, the Lambda publish dir).

**The services now talk over Clerk-authenticated calls.** The frontend `/me` page (`app/me/page.tsx`) makes a **server-side** call to the backend's protected `GET /me` using `BACKEND_URL` (the Compose network); `NEXT_PUBLIC_API_URL` remains available for browser-side calls via the host port. See **Authentication (Clerk)** below. The `/documents` page follows the same server-side pattern — see **Documents (S3)**.

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

**MCP server** — from `mcp/` (one-time: `uv venv --python 3.13 .venv && uv pip install --python .venv/bin/python -r requirements.txt`):

| Command | What |
| --- | --- |
| `.venv/bin/python server.py` | Run the MCP server on http://localhost:8000/mcp |
| `curl localhost:8000/health` | Liveness check (unauthenticated by design) |
| `curl localhost:8000/.well-known/oauth-protected-resource/mcp` | OAuth discovery doc — should list your Clerk instance |

**Docker Compose** — from the repo root:

| Command | What |
| --- | --- |
| `docker compose up --build` | Build + run frontend + backend |
| `docker compose --profile mcp up --build` | …plus the MCP server on 8000 |
| `docker compose up -d` | Start detached |
| `docker compose logs -f` | Tail logs |
| `docker compose down` | Stop and remove |

**Infra** — from the repo root (`npm install` once):

| Command | What |
| --- | --- |
| `npm run infra:check` | TypeScript-validates `infra/` + `sst.config.ts` — no AWS access |
| `npm run diff -- --stage test` | Preview infra changes against real state |
| `npm run deploy:test` | **Real, billable deploy** — go through the `deploy` skill, not by hand |

There is **no test suite** in any app — verify changes by building and running (see the `prime-context` skill). For infra changes the equivalent narrow check is `npm run infra:check`.

## Stack

- **Frontend:** Next.js **16.2.9** + React **19**, TypeScript, **App Router** (`app/`), no `src/` dir, **no Tailwind**, import alias `@/*`. `next.config.ts` sets `output: "standalone"` so the Docker image ships a trimmed `node_modules` + `server.js`. Auth via **Clerk** (`@clerk/nextjs`) — see Authentication below.
- **Backend:** .NET **10** (`net10.0`) **minimal API** in `backend/LoopedIn.Api/Program.cs` (`GET /` hello + the three `*/ping` configuration checks + protected `GET /me`), with document CRUD mapped from `Endpoints/DocumentEndpoints.cs`. OpenAPI via `Microsoft.AspNetCore.OpenApi` (no Swashbuckle); `Nullable` + `ImplicitUsings` + `TreatWarningsAsErrors` enabled, packages centrally versioned in `Directory.Packages.props`. Requires the **.NET 10 SDK** (installed here via Homebrew → `/opt/homebrew/bin/dotnet`). Protected endpoints are guarded by **Clerk JWT Bearer** auth — see Authentication below.
- **MCP:** Python **3.13** + **FastMCP 3.x** in `mcp/looped_in_mcp/` (`config`/`auth`/`middleware`/`backend`/`deps`/`app` + `tools/`), served over streamable HTTP at `/mcp`. Clerk is the OAuth **authorization server** via Dynamic Client Registration; this server is a **resource server** (`RemoteAuthProvider` + `JWTVerifier`). Runs under uvicorn locally and **Mangum** on Lambda — `server.py` is the only file that knows the difference. See `mcp/README.md`.
- **Containers:** multi-stage Dockerfiles, all three final images run **non-root**. Backend listens on `8080` inside the container (`ASPNETCORE_HTTP_PORTS`); host maps it to `5114`. MCP listens on `8000` in both.

## Database (Neon Postgres)

The backend talks to **Neon** (serverless Postgres) via **Npgsql** (a pooled `NpgsqlDataSource`). The connection string comes from the `DATABASE_URL` environment variable: locally it's loaded from a gitignored **`backend/.env.local`** (via `DotNetEnv`), and in Compose it's passed through `env_file` (optional, so `up` still works without it). `backend/.env.local.example` is the committed template — copy it to `.env.local` and paste your Neon URL.

- `DATABASE_URL` accepts **either** Neon's `postgresql://…` URL **or** a native Npgsql key/value string; `DbBootstrap.ToNpgsqlConnectionString` in `Program.cs` normalizes the URL form (and honors `?sslmode=`, defaulting to `Require` since Neon requires TLS).
- **`GET /db/ping`** is the connectivity check: runs `SELECT version(), now()` → `{ connected, version, serverTime }`. It returns **503** with a clear message when `DATABASE_URL` is unset, so the rest of the API runs fine with no DB configured.

## Documents (S3)

`/documents` is full CRUD over documents stored in the stack's S3 bucket. **Bytes never pass through the API**: it mints short-lived presigned URLs and the browser transfers directly to and from S3, which keeps uploads clear of the 10 MB API Gateway request cap and the Lambda payload limit.

- **Key layout is `documents/{clerkUserId}/{documentId}/{urlEncodedFilename}`** — built and parsed only by `Infrastructure/Storage/DocumentKey.cs`. The owner segment always comes from the validated token's `sub`, never from the request; a client sends a document **id**, never a key, so no request shape reaches another user's objects. Ids are **UUIDv7**, so S3's lexicographic listing order is chronological.
- **The filename lives in the key**, not just in `x-amz-meta-*`, because `ListObjectsV2` returns keys/sizes/timestamps but never user metadata — reading names from metadata would cost one `HeadObject` per row. `Uri.EscapeDataString` round-trips the original exactly and can't produce a `/`, so a document is always exactly one object.
- **There is no database table.** S3 is the whole source of truth, so documents work with `DATABASE_URL` unset.
- **Endpoints** (`Endpoints/DocumentEndpoints.cs`, all `.RequireAuthorization()` except ping): `GET /documents/ping` (public, mirrors `/db/ping`), `GET /documents`, `POST /documents` (→ presigned PUT), `POST /documents/{id}/complete`, `GET /documents/{id}`, `GET /documents/{id}/content` (→ presigned GET), `PATCH /documents/{id}` (rename), `DELETE /documents/{id}`.
- **Upload is three steps**: `POST /documents` → PUT the bytes to `uploadUrl` sending `requiredHeaders` **verbatim** (they're part of the signature, so a changed or missing header means a 403 from S3) → `POST /documents/{id}/complete`. Nothing exists in S3 until the PUT lands, so an abandoned upload leaves no debris.
- **Rename is copy-then-delete** — the filename is in the key, so there's no in-place edit. The id is preserved.
- **Config:** `Documents__Bucket` (required) and `Documents__Prefix` (default `documents/`). Unset → the app still boots and `/documents` reports **503** with the reason, like the DB and Clerk wiring. Credentials/region come from the standard AWS chain (`AWS_REGION`, env, `~/.aws`, and on Lambda the execution role) — **the API holds no AWS keys in configuration**.
- **The bucket's CORS is a separate layer from the gateway's.** The gateway's governs calls to the API; the bucket's governs the browser's direct PUT to S3. Both read `STAGE_CONFIG.corsAllowOrigins`, so a stage names its browser origins once — and the existing prod guard now covers the bucket too. A local dev bucket you create by hand needs a PUT rule for `http://localhost:3000`.
- **Frontend** (`app/documents/`): `types.ts` (shared shapes, no server imports, so the client component can use them), `api.ts` (server-side authenticated fetch over `BACKEND_URL`), `actions.ts` (`"use server"`), `document-manager.tsx` (client). The manager renders **straight from props** — mutating actions call `refresh()` from `next/cache` and new props arrive; a local `useState` mirror would go stale on every rename or delete.

## Authentication (Clerk)

Both apps use **Clerk**. The frontend was scaffolded by the Clerk CLI (`clerk init`, linked to app `ch-ai-platform` / `app_3Fmjg3lnavgRFblK0ccF518EYjj`); the backend validates Clerk-issued session JWTs. Like the DB wiring, the backend **no-ops gracefully** when Clerk is unconfigured — the app still boots, but protected endpoints reject every request with **401**.

**Frontend** (`@clerk/nextjs`):
- `ClerkProvider` wraps the body in `app/layout.tsx` (**inside `<body>`**, not `<html>`). The header shows sign-in/sign-up controls when signed out and a `UserButton` when signed in (`Show` / `SignInButton` / `SignUpButton` / `UserButton`), plus a "My API identity" link to `/me`.
- **`proxy.ts`** (Next 16 uses `proxy.ts`, **not** `middleware.ts`) protects all non-public routes — so `/` redirects to `/sign-in` when signed out; only the `app/sign-in` and `app/sign-up` routes are public. Its `config.matcher` includes `'/__clerk/:path*'` after `'/(api|trpc)(.*)'`.
- Publishable/secret keys live in gitignored **`frontend/.env.local`** (written by `clerk init`). **Never expose `CLERK_SECRET_KEY` client-side.** `auth()` is **async** — always `await auth()`; import it from `@clerk/nextjs/server` in server code.
- Dynamic auth UI is wrapped in `<Suspense>`. Note `next.config.ts` currently sets **`cacheComponents: false`** — OpenNext can't resume PPR, so the deployed app would serve only the static shell. The Suspense boundaries are kept so the flag can be flipped back on if the frontend ever moves to Vercel.

**Backend** (`Microsoft.AspNetCore.Authentication.JwtBearer`):
- Configured in `Infrastructure/Authentication/AuthenticationServiceCollectionExtensions.cs` (`AddClerkAuthentication`), wired in `Program.cs` with `UseAuthentication()` / `UseAuthorization()`.
- Reads **`Clerk:Authority`** (env `Clerk__Authority`) — the Clerk **Frontend API URL** (e.g. `https://<slug>.clerk.accounts.dev`); JWKS/OIDC discovery is automatic. Optional **`Clerk:AuthorizedParties`** (comma-separated) validates the token's `azp` claim. Set these in `backend/.env.local` (see `.env.local.example`); find the Frontend API URL in **Clerk Dashboard → API Keys**.

**Endpoints:**
- **`GET /auth/ping`** (public) — connectivity check mirroring `/db/ping`: reuses the JwtBearer handler's own `ConfigurationManager` to fetch Clerk's OIDC discovery → `{ configured, authority, issuer, jwksUri, signingKeys }`; **503** when `Clerk:Authority` is unset.
- **`GET /me`** (protected, `.RequireAuthorization()`) — returns `{ userId, email, claims }` from the validated token; **401** without a valid bearer. `/` and the `*/ping` checks stay public.

**MCP** (`mcp/looped_in_mcp/auth.py`):
- Reads **`CLERK_ISSUER`** — the same Clerk Frontend API URL the backend uses as `Clerk__Authority`. That shared issuer is what lets an MCP tool forward the caller's token straight to the API. In the cloud it comes from the `ClerkAuthority` SST secret; locally from `mcp/.env.local`.
- **No OAuth client id/secret exists anywhere** — clients self-register with Clerk through **Dynamic Client Registration**, which must be toggled on in the Clerk Dashboard (→ OAuth applications) or no client can connect.
- Unlike the API and frontend, the MCP server has **no unconfigured mode**: `Settings.from_env()` raises without `CLERK_ISSUER`. That's why the Compose service is behind the `mcp` profile.
- **`SERVER_BASE_URL` is deliberately unset in the cloud.** A Lambda can't reference its own public URL without a circular dependency, so `middleware.py` rewrites the OAuth discovery URLs to the host each request actually arrived on. Set it only behind a stable custom domain — or locally, to your ngrok tunnel URL.

**End-to-end:** the frontend `/me` page reads the Clerk token server-side (`await (await auth()).getToken()`) and calls the backend `GET /me` over `BACKEND_URL` — a server-side call, so no CORS and the token never reaches the browser. It's the smoke test for the whole trust chain. The MCP server's `my_api_identity` tool is the same test from the agent side, and `/connect` is the page that tells users how to hook a client up.

## Deployment (SST → AWS)

**Nothing has been deployed yet.** `sst.config.ts` is a thin entry point that dynamically imports the resource modules in **`infra/`** (SST forbids top-level imports there). `infra/index.ts` composes the graph; `infra/README.md` documents ownership per module, extension recipes, and the change checklist. **Read it before editing anything under `infra/`.**

- **Region is `ap-southeast-2`** (Sydney) for every stage — `AWS_REGION` in `infra/config/stages.ts`, not per-stage.
- **API Gateway is the only way into either Lambda.** An HTTP API (`$default` stage + `$default` route, AWS_PROXY, payload format 2.0) fronts the .NET Lambda with throttling, access logs, and CORS; a **second, separate** HTTP API does the same for the MCP Lambda. There are **no Function URLs** — each `lambda:Permission` is scoped to its own API's execution ARN. `AddAWSLambdaHosting(LambdaEventSource.HttpApi)` in `Program.cs` and Mangum in `mcp/server.py` are the matching halves; don't change either event source without changing `payloadFormatVersion`.
- **The MCP server has its own gateway on purpose.** Its OAuth discovery path (`/.well-known/oauth-protected-resource/mcp`) would collide with the API's `$default` catch-all, and a separate origin keeps the connector URL, throttle, and access log independent. Its CORS is **wildcard on every stage** — safe because it's bearer-token auth with `allowCredentials` off, and required by browser-based MCP clients. The prod origin guard covers the API only.
- **The MCP Lambda artifact is hash-locked.** `infra/artifacts/python-lambda.ts` runs `pip install --require-hashes` against `mcp/requirements-lambda.lock`, cross-resolved for `python3.13` + `manylinux2014_aarch64`, so the deploy host needs **`python3.13` on `PATH`**. After changing `mcp/requirements.txt`, regenerate the lock (command at the top of that file) or the install fails.
- **`MCP_URL` is not `NEXT_PUBLIC_`.** `NEXT_PUBLIC_*` values are inlined at build time; the connector URL only exists after the MCP gateway is created. `app/connect/page.tsx` reads it server-side after `await connection()`, so it resolves per request in Compose and on Lambda alike.
- **CORS lives on the gateway, not in `Program.cs`.** The .NET app registers no CORS middleware, so exactly one layer emits `Access-Control-Allow-*`. Adding ASP.NET CORS would produce duplicate headers that browsers reject.
- **`names.ts` is append-only.** Logical names are the identity behind Pulumi URNs — renaming one destroys and recreates that resource. `OUTPUT_KEYS` (`web`, `api`, `bucket`) is a documented contract.
- **The S3 bucket in `infra/storage/bucket.ts` is the document store.** Private, TLS-only, unversioned, with CORS scoped to the stage's browser origins so the direct-to-S3 upload works. The API Lambda's role is granted **named actions on `documents/*` only** (`grantDocumentsAccess` in `shared/iam.ts`) — object actions scoped by ARN, plus `s3:ListBucket` confined by an `s3:prefix` condition, because listing is a bucket-level action a resource ARN can't narrow. Never reach for `s3:*`. Presigned URLs need no extra grant: S3 evaluates *this role's* permissions when the browser redeems one, so the prefix scope still binds.
- **`DOCUMENTS_PREFIX` in `storage/bucket.ts` is shared** by the IAM grant and the API's `Documents__Prefix` env var, so the permission boundary and the code's idea of where documents live can't drift.
- **The bucket is created before the API** in `index.ts` because the API needs its name. Ordering there is presentational only — Pulumi derives URNs from `names.ts`, not declaration order.
- **One secret manifest**, `infra/config/secrets.json`, is read by both `scripts/deploy.mjs` (dotenv → SSM) and `infra/config/secrets.ts` (the `sst.Secret` handles), so the two can't drift.
- **`prod` fails fast** before touching AWS while `STAGE_CONFIG.prod.corsAllowOrigins` is empty or `"*"`.
- Deploys are **denied by `.claude/settings.json`** and go through the `deploy` skill deliberately. `npm run infra:check` is the safe local check.

## Agent teams (Claude Code)

This repo is set up for [agent teams](https://code.claude.com/docs/en/agent-teams) — `.claude/settings.json` enables `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`. Teams shine here because the work splits cleanly along the `frontend/` ↔ `backend/` ↔ `mcp/` ↔ infra boundary, so teammates own non-overlapping files and don't step on each other.

**Standard full-stack team** — four project subagents in `.claude/agents/` double as teammate roles. Spawn them by name, e.g.:

> Spawn four teammates for this change: a **frontend** teammate, a **backend** teammate, an **mcp** teammate, and an **infra** teammate. Frontend owns `frontend/`, backend owns `backend/`, mcp owns `mcp/`, infra owns Compose/Dockerfiles/SST. Have them coordinate on the `/me` contract.

| Role (`.claude/agents/`) | Owns | Don't touch |
| --- | --- | --- |
| `frontend` | `frontend/` (Next 16 App Router, Clerk UI, Cache Components) | backend, mcp, infra |
| `backend`  | `backend/LoopedIn.Api` (endpoints, Clerk JWT, Neon/Npgsql) | frontend, mcp, infra |
| `mcp`      | `mcp/` (FastMCP tools, Clerk OAuth/DCR, the API seam) | frontend, backend, infra |
| `infra`    | `docker-compose.yml`, Dockerfiles, `sst.config.ts` + `infra/`, OpenNext, env wiring | app source |

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
