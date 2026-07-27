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
scripts/import_clients.py ← xlsx → data/clients-import.sql + report (Python 3.13 stdlib only); see Clients below
DEPLOY.md            ← what gets deployed, secrets table, one-time setup, teardown
.claude/skills/      ← prime-context (session priming) + future reference skills
```

Each app carries its own container setup: `frontend/Dockerfile` + `frontend/.dockerignore`, `backend/Dockerfile` + `backend/.dockerignore`, `mcp/Dockerfile` + `mcp/.dockerignore`. `.gitignore`s live per-app (`frontend/.gitignore`, `backend/.gitignore`, `mcp/.gitignore`) except the root one, which covers the infra (`.sst/`, root `node_modules/`, `.open-next/`, the Lambda publish dir).

**`/*.xlsx` and `/data/` are gitignored because they hold personal data.** The outreach spreadsheet names ~150 individuals and their work contact details, and the importer's generated SQL and report carry the same data. Committing any of it puts personal data in git history permanently, where deleting the file does not remove it. The importer regenerates `data/` on demand — deterministically — which is what makes ignoring it safe rather than lossy.

**The services now talk over Clerk-authenticated calls.** The frontend `/me` page (`app/(app)/me/page.tsx`) makes a **server-side** call to the backend's protected `GET /me` using `BACKEND_URL` (the Compose network); `NEXT_PUBLIC_API_URL` remains available for browser-side calls via the host port. See **Authentication (Clerk)** below. The `/documents` page follows the same server-side pattern — see **Documents (S3)**.

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

- **Frontend:** Next.js **16.2.9** + React **19**, TypeScript, **App Router** (`app/`), no `src/` dir, **no Tailwind**, import alias `@/*` (use it for anything crossing the `(app)` route-group boundary — a relative path breaks when a route moves). `three` is the only other runtime dependency, imported dynamically by the landing scene. `next.config.ts` sets `output: "standalone"` so the Docker image ships a trimmed `node_modules` + `server.js`. Auth via **Clerk** (`@clerk/nextjs`) — see Authentication below.
- **Backend:** .NET **10** (`net10.0`) **minimal API** in `backend/LoopedIn.Api/Program.cs` (`GET /` hello + the three `*/ping` configuration checks + protected `GET /me`), with document CRUD mapped from `Endpoints/DocumentEndpoints.cs` and client CRUD from `Endpoints/ClientEndpoints.cs`. OpenAPI via `Microsoft.AspNetCore.OpenApi` (no Swashbuckle); `Nullable` + `ImplicitUsings` + `TreatWarningsAsErrors` enabled, packages centrally versioned in `Directory.Packages.props`. Requires the **.NET 10 SDK** (installed here via Homebrew → `/opt/homebrew/bin/dotnet`). Protected endpoints are guarded by **Clerk JWT Bearer** auth — see Authentication below.
- **MCP:** Python **3.13** + **FastMCP 3.x** in `mcp/looped_in_mcp/` (`config`/`auth`/`middleware`/`backend`/`deps`/`app` + `tools/`), served over streamable HTTP at `/mcp`. Clerk is the OAuth **authorization server** via Dynamic Client Registration; this server is a **resource server** (`RemoteAuthProvider` + `JWTVerifier`). Runs under uvicorn locally and **Mangum** on Lambda — `server.py` is the only file that knows the difference. See `mcp/README.md`.
- **Containers:** multi-stage Dockerfiles, all three final images run **non-root**. Backend listens on `8080` inside the container (`ASPNETCORE_HTTP_PORTS`); host maps it to `5114`. MCP listens on `8000` in both.

## Design system

The visual language comes from the **Looped In brand site, <https://www.looped-in.com.au/>** — a Squarespace site whose theme defines the palette in HSL. `app/globals.css` is the single source of truth in this repo; it records the source values and exposes them as tokens. **Style against the tokens, never against raw hexes** — that is what lets a new surface (the dashboard) inherit the theme for free.

**The shipped default is no longer the brand site's palette.** The app now defaults to **Dusk** (twilight violet and candle amber), made permanent from the colour picker; the brand palette below is still selectable as the picker's **"Brand site"** preset. The table that follows is therefore **provenance — where each token's role came from, not what it currently resolves to**. `globals.css` holds the live values. The upshot for anyone reading a token name: **the anchor names are roles, not hues** — `--li-indigo` is a violet today and `--li-eggplant` an amber, so only the role still describes the colour.

| Brand value | HSL on the site | Hex | Token |
| --- | --- | --- | --- |
| "white" — the page ground | `hsl(48, 24%, 84%)` | `#e0dccc` | `--li-cream` → `--background` (light) |
| "black" | `hsl(6, 100%, 0%)` | `#000000` | `--li-ink` → `--foreground` (light) |
| lightAccent | `hsl(192, 49%, 82%)` | `#bbdfe8` | `--li-sky` → `--li-accent` |
| darkAccent | `hsl(33, 100%, 14%)` | `#472700` | `--li-eggplant` → `--li-meta` (light) |
| accent | `hsl(225, 39%, 50%)` | `#4e67b1` | `--li-indigo` → `--li-rule` (light) |

- **The ground is never white** — it is a tinted paper (`#e4dee6` under Dusk, `#e0dccc` on the brand palette). Reaching for `#fff` is the fastest way to look off-theme.
- **Semantic tokens flip with the colour scheme; raw `--li-*` colours don't.** Dark mode uses a near-black carrying the palette's own hue (`--li-night`, `#171325` under Dusk) rather than a neutral inversion, and swaps `--li-meta`/`--li-rule` to sky — indigo goes muddy on the dark ground, sky is illegible on the light one. Other tokens: `--li-surface`, `--li-line`, `--li-accent-foreground`, `--li-radius-button` (6.4px), `--li-radius-panel`, `--li-heading-tracking`, `--li-heading-leading`, `--li-body-leading`.
- **There are seven raw colours, not five.** `--li-night` (the dark ground) and `--li-plum` (a second dark tone, from the lockup's wordmark ink) join the five brand roles above. Both were literals before — the night inside the dark media block, `0x351f40` inside `loop-scene.tsx` — and are tokens now so the colour picker can drive them.
- **The app ships light, and dark is opt-in — it does not follow the OS by default.** With no `data-li-scheme` on `<html>` (every first visit, every no-JS render) the `:root` block stands and the app is light. The picker's three choices write the attribute: `light`, `dark`, or `auto`, and **`auto` is the only one that follows `prefers-color-scheme`**.
- **The dark scheme is declared twice, and must stay identical.** `@media (prefers-color-scheme: dark) :root[data-li-scheme="auto"]` and `:root[data-li-scheme="dark"]`. CSS cannot OR a media query with a selector, and the picker has to be able to *pin* a scheme so the dark half of a palette can be judged from a light-mode machine.
- **Type:** headings/body are **Aileron** on the brand site at weight 400 with **positive** `.02em` tracking over 1.2 leading — not the tightened negative tracking a wordmark usually gets. Aileron is not on Google Fonts, so **Geist** (same Helvetica lineage, already loaded) stands in; swapping in self-hosted Aileron via `next/font/local` is a drop-in. Meta/eyebrow text is **Space Mono** (`--font-space-mono`); `--font-geist-mono` stays the *code* face (connector URLs, claim names) so the two monospaces never do the same job.
- **Buttons:** uppercase, weight 700, `--li-radius-button`, `1rem 1.3rem` padding — straight off the brand site.
- **The logo is the real artwork, in `public/`.** `looped-in-logo.png` is the lockup the brand site serves (plum `#351f40` wordmark + indigo `#4f67b1` mark, transparent); `looped-in-logo-dark.png` is the same file with the wordmark re-inked to cream, because plum on the dark ground is ~1.4:1. `app/lib/brand-logo.tsx` renders the light lockup as a plain `<img>` and lets `brand-logo.module.css` paint the dark one as a background over it. **It is no longer a `<picture>` media source**: that selected on `prefers-color-scheme`, which stopped matching the ground the moment dark became opt-in — a dark-mode machine would have been served the cream wordmark on the light default ground, where it is invisible. The CSS conditions must therefore stay exactly the two that darken the ground in `globals.css`. **Note the wordmark ink is a plum, not the `#472700` the token table calls eggplant** — the Squarespace theme value and the logo artwork genuinely differ, so `--li-eggplant` was left alone rather than redefined. **The artwork is raster, so it does not follow the palette**: under Dusk (or any preset) the lockup still renders the original plum wordmark and indigo mark, which is why the colour picker can restyle every surface around it but not the logo itself. Re-inking it means new PNGs. A background-image in a rule that does not match is never requested, so the light default still fetches exactly one file and runs no JS; opting into dark costs the second fetch.
- **`public/looped-in-mark.svg` is the mark alone**, rebuilt as vector: two circles of radius 47 with centres 176 apart, bridged by a concave fillet of radius 75 tangent to both. Those numbers are exact, not fitted (47 + 75 = 122 = the centre-to-fillet distance), which is why the same constants drive the 3D form in `app/loop-scene.tsx`. Change them in one place and they must change in the other.

### The colour picker

A permanent palette picker, mounted once in `app/layout.tsx` so it rides every screen. `app/lib/palette.ts` is the model, `palette-storage.ts` the persistence, `palette-boot.tsx` the no-flash boot script, `colour-picker.tsx` + its CSS module the UI.

- **It writes the seven raw `--li-*` colours as inline custom properties on `<html>`, and nothing else.** Every semantic token derives from those seven through `var()`/`color-mix()`, so one write re-themes every route and CSS module at once. There is deliberately **no ramp engine** — the design system's own cascade does the deriving.
- **`DEFAULT_PALETTE` in `palette.ts` mirrors the `:root` block of `globals.css`.** Retune one and you must retune the other.
- **The contrast readout is the point, not decoration.** The token table above is *argued* from contrast, so the way a permutation fails is by quietly dropping a pair below its threshold. `CONTRAST_CHECKS` encodes the pairs the design already depends on, and `randomPalette()` re-draws until it passes them. Note `--li-rule` is sky in the dark scheme, so there is no indigo-on-night rule to check — what indigo keeps there is the scene mark.
- **The landing scene reads `--li-scene-mark`** instead of holding a hex, and re-reads on the `PALETTE_EVENT` (`looped-in:palette`) the picker dispatches. That is what keeps the WebGL material on brand by construction. (`--li-scene-node` remains defined in globals.css but nothing reads it since the client ring was removed from the scene.)
- **State is per-browser (localStorage) and shareable as `?palette=`** — a preset id or seven dot-separated hexes. `ANCHORS` order is the wire format: append only, never reorder. Everything read back is re-validated; a malformed link is ignored rather than allowed to wipe a saved palette.
- **Making a permutation permanent is a deliberate code edit**: "Copy CSS" in the panel, paste over the raw block in `globals.css`, mirror into `DEFAULT_PALETTE`.

## Frontend shape (two screens, not one)

The app has **two chrome shapes that share no frame**, split by route group. `app/layout.tsx` is fonts, tokens, `ClerkProvider`, and the two pieces that must outlive any single screen — the colour picker and its boot script. No page chrome.

- **Stand-alone, straight under the root layout:** `app/page.tsx` (the signed-out landing), `app/sign-in/`, `app/sign-up/`. No sidebar, no header. The auth pages share `app/lib/auth-screen.tsx` for the lockup above the Clerk widget.
- **`app/(app)/`** wraps everything behind sign-in in `app-shell.tsx` — a logo-only fixed header over a fixed nav rail, the rail becoming a drawer under 1024px. **The route group adds nothing to the URL**: `(app)/clients/page.tsx` is still `/clients`. The shell wraps content in a plain `<div>`, not `<main>`, because every page already renders its own `<main>` with its own max-width — which is why the shell adds no padding of its own.
- **The header carries the brand and nothing else** (plus the drawer toggle under 1024px, since with the rail off-canvas there is nowhere else for it). Navigation lives in the rail; the Clerk `UserButton` lives in the rail's footer.
- **`app/page.tsx` + `app/loop-scene.tsx` are the reference implementation.** The landing is one screen: lockup, two CTAs, and a `three` scene of the brand mark tumbling gradually on all three axes. `three` is **dynamically imported** so ~600 KB stays off first paint. The scene reads its one colour from `--li-scene-mark` and re-reads it on scheme and palette changes; when WebGL is unavailable the stage simply stays empty — everything that carries meaning (lockup, CTAs) is real DOM.
- **`proxy.ts` redirects `/` to `/dashboard` for a signed-in visitor.** Doing it in middleware rather than the page is what keeps the landing free of `auth()` and therefore prerendered — `next build` should show `/` as `○ (Static)` and every `(app)` route as `ƒ`.

## Database (Neon Postgres)

The backend talks to **Neon** (serverless Postgres) via **Npgsql** (a pooled `NpgsqlDataSource`). The connection string comes from the `DATABASE_URL` environment variable: locally it's loaded from a gitignored **`backend/.env.local`** (via `DotNetEnv`), and in Compose it's passed through `env_file` (optional, so `up` still works without it). `backend/.env.local.example` is the committed template — copy it to `.env.local` and paste your Neon URL.

- `DATABASE_URL` accepts **either** Neon's `postgresql://…` URL **or** a native Npgsql key/value string; `DbBootstrap.ToNpgsqlConnectionString` in `Program.cs` normalizes the URL form (and honors `?sslmode=`, defaulting to `Require` since Neon requires TLS). An unparseable value degrades like an unset one — it never takes the whole API down.
- **`GET /db/ping`** is the connectivity check: runs `SELECT version(), now()` → `{ connected, version, serverTime }`. It returns **503** with a clear message when `DATABASE_URL` is unset **or when startup migration failed**, so the rest of the API runs fine with no DB configured.
- **`DatabaseState` is the single answer to "is the database usable".** A *mutable* singleton, unlike the immutable `DocumentStorageStatus`, because migrations run after `builder.Build()` has sealed the DI container — the holder has to exist before the outcome does. It is registered on **both** branches of `AddNeonDatabase` and starts unavailable.

### Migrations

Numbered SQL files in `backend/LoopedIn.Api/Infrastructure/Database/Migrations/`, embedded in the assembly (wildcard `EmbeddedResource`) and applied by `DatabaseMigrator` after `builder.Build()`. **Read `Migrations/README.md` before adding one** — it is the contract. In short:

- **Files are append-only and an applied file is never edited.** Each file's SHA-256 is recorded on apply and re-checked every boot; a mismatch is a **hard failure**, because the deployed schema and the repo disagreeing is not something to guess about. Checksums are over newline-normalized text, so a CRLF checkout doesn't hard-fail a boot over an unchanged schema.
- **The lock is `pg_advisory_xact_lock`, never `pg_advisory_lock`.** A session lock silently stops providing mutual exclusion through PgBouncer transaction pooling — which is exactly what Neon's pooled endpoint is. Use the **pooled endpoint** on deployed stages; Lambda concurrency multiplies connections and Npgsql's pool is per-instance.
- **Warm boots take no lock at all**: the journal is read first and, if nothing is pending, the run is one round trip. That keeps Lambda cold starts off the lock.
- **A failure is never fatal.** It is logged, recorded in `DatabaseState`, and surfaced as 503 by `/db/ping` and every `/clients` route. The app boots either way; serving CRUD against a half-migrated schema would be worse than serving nothing.

## Clients (Neon Postgres)

`/clients` is CRUD over a shared client list and its contacts — the first real SQL schema in the repo (`clients` + `contacts`, migration `0001`).

- **These rows are shared by every signed-in user**, the deliberate opposite of documents. A document's S3 key derives from the caller's own `sub`, so no request shape reaches another user's data; here everyone reads and writes everything. `.RequireAuthorization()` on the group is the *only* line of defence, which makes **who can sign up to the Clerk instance a security decision for this feature** — restrict sign-up before seeding real data. `created_by`/`updated_by` always come from the validated token, never the body.
- **`version` (bigint) is the optimistic-concurrency token, and this is the house pattern** for every future mutable table. `PATCH` requires `expectedVersion` (**400** without it — optional protection is decorative the day the UI forgets), the UPDATE carries `where version = @expected`, and zero rows affected is disambiguated into **404** or **409**. `updated_at` is display-only: a timestamp would have to round-trip Postgres microseconds through JSON and a JS `Date` bit-exactly, and it can't.
- **`PATCH` is a full replacement of the mutable fields, not a merge.** With records and System.Text.Json an absent property and an explicit `null` are indistinguishable, so merge-patch cannot be expressed — `null` means *clear the field*. This is why editing from a list row (`updateClientFromRow`) reads the current `notes` first: the row doesn't carry them, and omitting them would wipe them.
- **`DatabaseGateFilter` (`Infrastructure/Http/`) is the shared preamble as composition** — 503 when the database is unusable, 401 when the token has no subject, `NpgsqlException` → 503, **unique violation (23505) → 409**. Stated once on the group with `AddEndpointFilter`, so a route added later can't forget it. `ClaimsPrincipalExtensions.GetSubject()` is now the one definition of "who is calling" (`/me` and `DocumentEndpoints` were retrofitted to it).
- **Handlers take `IServiceProvider`, not `ClientStore`.** Minimal-API parameter binding runs *before* endpoint filters, so an unregistered service would blow up in front of the 503 the filter exists to give.
- **Validation mirrors the CHECK constraints** (`Models/ClientValidation.cs`) so a violation is a 400 and never a 500. `IsPlausibleEmail` **must stay equivalent to `is_plausible_email` in `scripts/import_clients.py`** — the importer writes straight to Postgres and bypasses request validation, so a stricter rule here doesn't reject bad data, it makes already-stored rows uneditable. (A trailing dot is tolerated on both sides for exactly that reason.)
- **Search is `ilike` with `%`, `_` and `\` escaped**, matched `escape '\'` so searching `100%` finds the literal string. At ~200 rows a sequential scan is correct; `pg_trgm` is the fix at five figures, not before. Ordering is always `(created_at desc, id desc)` — every seeded row shares one `created_at`, so the id tiebreak is what makes paging stable.
- **Frontend `app/(app)/clients/`** follows `app/(app)/documents/`: `types.ts` (no server imports), `actions.ts` (`"use server"`), a client manager rendering **straight from props**. **List state lives in the URL** — a client component can't call `callBackend`, so the search box and pager `router.replace('?search=&page=')`, the server component re-reads `searchParams` and re-fetches. That is the house pattern for list screens.
- **Seed data** comes from `scripts/import_clients.py` (Python 3.13 stdlib only) → gitignored `data/`. Ids are **deterministic UUIDv5**, because regenerating the file is the normal path and regenerated UUIDv7s would turn `on conflict do nothing` into mass duplication. The script asserts its own output counts and refuses to write when they drift.

## Documents (S3)

`/documents` is full CRUD over documents stored in the stack's S3 bucket. **Bytes never pass through the API**: it mints short-lived presigned URLs and the browser transfers directly to and from S3, which keeps uploads clear of the 10 MB API Gateway request cap and the Lambda payload limit.

- **Key layout is `documents/{clerkUserId}/{documentId}/{urlEncodedFilename}`** — built and parsed only by `Infrastructure/Storage/DocumentKey.cs`. The owner segment always comes from the validated token's `sub`, never from the request; a client sends a document **id**, never a key, so no request shape reaches another user's objects. Ids are **UUIDv7**, so S3's lexicographic listing order is chronological.
- **The filename lives in the key**, not just in `x-amz-meta-*`, because `ListObjectsV2` returns keys/sizes/timestamps but never user metadata — reading names from metadata would cost one `HeadObject` per row. `Uri.EscapeDataString` round-trips the original exactly and can't produce a `/`, so a document is always exactly one object.
- **There is no database table.** S3 is the whole source of truth, so documents work with `DATABASE_URL` unset.
- **Endpoints** (`Endpoints/DocumentEndpoints.cs`, all `.RequireAuthorization()` except ping): `GET /documents/ping` (public, mirrors `/db/ping`), `GET /documents`, `POST /documents` (→ presigned PUT), `POST /documents/{id}/complete`, `GET /documents/{id}`, `GET /documents/{id}/content` (→ presigned GET), `PATCH /documents/{id}` (rename), `DELETE /documents/{id}`.
- **Upload is three steps**: `POST /documents` (body: `filename`, `contentType`, `size`) → PUT the bytes to `uploadUrl` sending `requiredHeaders` **verbatim** (they're part of the signature, so a changed or missing header means a 403 from S3) → `POST /documents/{id}/complete`. Nothing exists in S3 until the PUT lands, so an abandoned upload leaves no debris.
- **The upload size limit is advisory, not enforced.** `size` is required on `POST /documents` and anything over `Documents__MaxUploadBytes` (default 100 MiB) is refused with **413** before a URL is signed. That stops an honest oversized upload; it does **not** stop a hostile client understating its size and then PUTting up to S3's 5 GB single-object limit, because a SigV4 *query-signed* URL has nowhere to carry a length constraint. Real enforcement means moving to a presigned **POST policy** with `content-length-range` — a change to both halves of the upload, deliberately not made yet.
- **Rename is copy-then-delete** — the filename is in the key, so there's no in-place edit. The id is preserved.
- **Config:** `Documents__Bucket` (required), `Documents__Prefix` (default `documents/`), `Documents__MaxUploadBytes` (default 100 MiB). Unset → the app still boots and `/documents` reports **503** with the reason, like the DB and Clerk wiring. Credentials/region come from the standard AWS chain (`AWS_REGION`, env, `~/.aws`, and on Lambda the execution role) — **the API holds no AWS keys in configuration**.
- **The bucket's CORS is a separate layer from the gateway's.** The gateway's governs calls to the API; the bucket's governs the browser's direct PUT to S3. Both read `STAGE_CONFIG.corsAllowOrigins`, so a stage names its browser origins once — and the existing prod guard now covers the bucket too. A local dev bucket you create by hand needs a PUT rule for `http://localhost:3000`.
- **Frontend** (`app/(app)/documents/`): `types.ts` (shared shapes, no server imports, so the client component can use them), `actions.ts` (`"use server"`), `document-manager.tsx` (client). The authenticated fetch itself lives in **`app/lib/backend.ts`** (`callBackend`) — shared with the `/me` page, which is the other caller. The manager renders **straight from props** — mutating actions call `refresh()` from `next/cache` and new props arrive; a local `useState` mirror would go stale on every rename or delete.

## Authentication (Clerk)

Both apps use **Clerk**. The frontend was scaffolded by the Clerk CLI (`clerk init`, linked to app `ch-ai-platform` / `app_3Fmjg3lnavgRFblK0ccF518EYjj`); the backend validates Clerk-issued session JWTs. Like the DB wiring, the backend **no-ops gracefully** when Clerk is unconfigured — the app still boots, but protected endpoints reject every request with **401**.

**Frontend** (`@clerk/nextjs`):
- `ClerkProvider` wraps the body in `app/layout.tsx` (**inside `<body>`**, not `<html>`). The signed-out `SignInButton` / `SignUpButton` live on the landing page; the signed-in `UserButton` lives in the app shell's nav-rail footer. There is no auth-reactive header any more — the two states are different screens, so nothing has to flip in place.
- **`proxy.ts`** (Next 16 uses `proxy.ts`, **not** `middleware.ts`) protects all non-public routes. Public are `/` (the landing, so signed-out visitors get the front door rather than a bounce), `app/sign-in` and `app/sign-up` — **everything else, including anything added later, is protected by default**. `/` is an exact match, so `/dashboard`, `/clients`, `/documents`, `/me` and `/connect` stay behind auth. It also **redirects `/` to `/dashboard` when a session exists**. Its `config.matcher` includes `'/__clerk/:path*'` after `'/(api|trpc)(.*)'`.
- Publishable/secret keys live in gitignored **`frontend/.env.local`** (written by `clerk init`). **Never expose `CLERK_SECRET_KEY` client-side.** `auth()` is **async** — always `await auth()`; import it from `@clerk/nextjs/server` in server code.
- Dynamic auth UI is wrapped in `<Suspense>`. Note `next.config.ts` currently sets **`cacheComponents: false`** — OpenNext can't resume PPR, so the deployed app would serve only the static shell. The Suspense boundaries are kept so the flag can be flipped back on if the frontend ever moves to Vercel.

**Backend** (`Microsoft.AspNetCore.Authentication.JwtBearer`):
- Configured in `Infrastructure/Authentication/AuthenticationServiceCollectionExtensions.cs` (`AddClerkAuthentication`), wired in `Program.cs` with `UseAuthentication()` / `UseAuthorization()`.
- Reads **`Clerk:Authority`** (env `Clerk__Authority`) — the Clerk **Frontend API URL** (e.g. `https://<slug>.clerk.accounts.dev`); JWKS/OIDC discovery is automatic. Set it in `backend/.env.local` (see `.env.local.example`); find the URL in **Clerk Dashboard → API Keys**.
- **Set `Clerk__AuthorizedParties` on any deployed stage.** Clerk session tokens carry no fixed `aud`, so `ValidateAudience` is off — meaning that with this list empty the API accepts **every** token the Clerk instance issued, including one minted for a third-party OAuth client that self-registered via DCR and got the user to click Allow. The comma-separated `azp` allow-list is what narrows that to your own origins. `/auth/ping` reports `authorizedParties` and warns when it's empty.

**Endpoints:**
- **`GET /auth/ping`** (public) — connectivity check mirroring `/db/ping`: reuses the JwtBearer handler's own `ConfigurationManager` to fetch Clerk's OIDC discovery → `{ configured, authority, issuer, jwksUri, signingKeys }`; **503** when `Clerk:Authority` is unset.
- **`GET /me`** (protected, `.RequireAuthorization()`) — returns `{ userId, email, claims }` from the validated token; **401** without a valid bearer. `/` and the `*/ping` checks stay public.

**MCP** (`mcp/looped_in_mcp/auth.py`):
- Reads **`CLERK_ISSUER`** — the same Clerk Frontend API URL the backend uses as `Clerk__Authority`. That shared issuer is what lets an MCP tool forward the caller's token straight to the API. In the cloud it comes from the `ClerkAuthority` SST secret; locally from `mcp/.env.local`.
- **No OAuth client id/secret exists anywhere** — clients self-register with Clerk through **Dynamic Client Registration**, which must be toggled on in the Clerk Dashboard (→ OAuth applications) or no client can connect.
- Unlike the API and frontend, the MCP server has **no unconfigured mode**: `Settings.from_env()` raises without `CLERK_ISSUER`. That's why the Compose service is behind the `mcp` profile.
- **`SERVER_BASE_URL` is deliberately unset in the cloud.** A Lambda can't reference its own public URL without a circular dependency, so `middleware.py` rewrites the OAuth discovery URLs to the host each request actually arrived on. Set it only behind a stable custom domain — or locally, to your ngrok tunnel URL. **A blank value counts as unset**, so `SERVER_BASE_URL=` and deleting the line behave identically (getting this wrong would pin the unresolvable `.invalid` sentinel *and* switch the rewrite off — a silent handshake failure).
- **The rewrite validates the `Host` header** before reflecting it into the OAuth discovery surfaces: scheme must be http/https, host must match the RFC 3986 reg-name shape. Optional **`ALLOWED_PUBLIC_HOSTS`** (comma-separated) narrows it to an explicit list — worth setting anywhere the public hostname is actually known; it can't be the default because the gateway domain isn't knowable at deploy time.

**End-to-end:** the frontend `/me` page reads the Clerk token server-side (`await (await auth()).getToken()`) and calls the backend `GET /me` over `BACKEND_URL` — a server-side call, so no CORS and the token never reaches the browser. It's the smoke test for the whole trust chain. The MCP server's `my_api_identity` tool is the same test from the agent side, and `/connect` is the page that tells users how to hook a client up.

## Deployment (SST → AWS)

**Nothing has been deployed yet.** `sst.config.ts` is a thin entry point that dynamically imports the resource modules in **`infra/`** (SST forbids top-level imports there). `infra/index.ts` composes the graph; `infra/README.md` documents ownership per module, extension recipes, and the change checklist. **Read it before editing anything under `infra/`.**

- **Region is `ap-southeast-2`** (Sydney) for every stage — `AWS_REGION` in `infra/config/stages.ts`, not per-stage.
- **API Gateway is the only way into either Lambda.** An HTTP API (`$default` stage + `$default` route, AWS_PROXY, payload format 2.0) fronts the .NET Lambda with throttling, access logs, and CORS; a **second, separate** HTTP API does the same for the MCP Lambda. There are **no Function URLs** — each `lambda:Permission` is scoped to its own API's execution ARN. `AddAWSLambdaHosting(LambdaEventSource.HttpApi)` in `Program.cs` and Mangum in `mcp/server.py` are the matching halves; don't change either event source without changing `payloadFormatVersion`.
- **The MCP server has its own gateway on purpose.** Its OAuth discovery path (`/.well-known/oauth-protected-resource/mcp`) would collide with the API's `$default` catch-all, and a separate origin keeps the connector URL, throttle, and access log independent. Its CORS is **wildcard on every stage** — safe because it's bearer-token auth with `allowCredentials` off, and required by browser-based MCP clients. The prod origin guard covers the API only.
- **The MCP Lambda artifact is hash-locked.** `infra/artifacts/python-lambda.ts` runs `pip install --require-hashes` against `mcp/requirements-lambda.lock`, cross-resolved for `python3.13` + `manylinux2014_aarch64`, so the deploy host needs **`python3.13` on `PATH`**. After changing `mcp/requirements.txt`, regenerate the lock (command at the top of that file) or the install fails.
- **`MCP_URL` is not `NEXT_PUBLIC_`** — but not because a post-gateway value couldn't be. SST resolves Outputs in `environment` by building with a placeholder and substituting it in the output assets, which is exactly how `NEXT_PUBLIC_API_URL` works. The reason is scope: only `/connect` needs the connector URL and it reads it server-side, so there's no cause to inline it into every client bundle. `app/connect/page.tsx` reads it after `await connection()`, so it resolves per request in Compose and on Lambda alike.
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
- **Tailwind is not installed** — style with CSS Modules plus the design tokens in `app/globals.css` (see **Design system** below).
- **`.env.local` loads before the host is built:** `DbBootstrap.LoadDotEnvLocal` runs **before** `WebApplication.CreateBuilder` in `Program.cs`, so `.env.local` values land in the process environment before the configuration provider snapshots them. Anything read via `IConfiguration` (e.g. `Clerk:Authority`) depends on this ordering; `DATABASE_URL` is read via `Environment.GetEnvironmentVariable` directly so it's order-independent, but keep the load first.
