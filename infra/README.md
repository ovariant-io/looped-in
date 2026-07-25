# Looped In infrastructure modules

`sst.config.ts` is the thin SST entry point (SST forbids top-level imports there, so it
dynamically imports these modules inside `app()`/`run()`). `infra/index.ts` composes the
deployed graph in dependency order; plain functions are used deliberately so moving
declarations between modules does not introduce Pulumi component parents or change
resource URNs — a rename in `names.ts` is a destroy/recreate.

## Topology

```
CloudFront + S3 (OpenNext)     API Gateway HTTP API ($default stage)
        │                                │  throttled, access-logged
   Next.js server Lambda ────────────────┘
                                         │  AWS_PROXY, payload format 2.0
                                  .NET 10 API Lambda (arm64, dotnet10)
                                         │  public internet, TLS
                                   Neon Postgres · Clerk JWKS

S3 storage bucket (private)  ← standalone: no consumer, no IAM grant, no env var yet
```

The API Lambda has **no Function URL** — API Gateway is its only invoke path, granted by a
single `lambda:Permission` scoped to this API's execution ARN.

The storage bucket (`storage/bucket.ts`) is deliberately disconnected from that graph:
nothing in either app can reach it until someone grants the API Lambda's role scoped `s3:`
actions on its ARN and passes `bucket.name` into the function environment.

## Ownership

| Area | Owner |
| --- | --- |
| App/stage policy (removal, protect, region) | `app.ts`, `config/stages.ts` |
| Per-stage settings, budget constants, prod CORS guard | `config/stages.ts` |
| SST secret names + dotenv sources (shared with `scripts/deploy.mjs`) | `config/secrets.json`, `config/secrets.ts` |
| `dotnet publish` of the API Lambda artifact | `artifacts/dotnet-lambda.ts` |
| API Lambda (env, memory, timeout) | `services/api.ts` |
| API Gateway HTTP API edge (route, throttle, CORS, access logs) | `services/gateway.ts` |
| Next.js (OpenNext) frontend | `services/web.ts` |
| General-purpose S3 bucket (private, unwired) | `storage/bucket.ts` |
| Budget alarm | `operations/budget.ts` |
| IAM primitives | `shared/iam.ts` |
| Frozen logical names + output contract | `names.ts` |
| Stable output assembly | `index.ts` |

## Extension recipes

### Add a secret

1. Add one entry to `config/secrets.json` (SST name + which app's `.env.<stage>` file and
   key it loads from). `scripts/deploy.mjs` reads the same manifest. `required: false`
   entries get an empty-string default so an unset stage still deploys.
2. Add the typed handle in `config/secrets.ts` and pass it only to explicit consumers.
3. Update the secret table in `DEPLOY.md`.

### Add a stage setting

1. Add the field to `StageConfig`/`STAGE_CONFIG` in `config/stages.ts`.
2. Pass it only to the modules that consume it via `StageSettings`.

### Add a resource

1. Add its logical name to `names.ts` (never rename existing entries).
2. Put it in the domain module it belongs to (`services/`, `operations/`, …), or create a
   new focused module.
3. Wire only its real dependencies and consumers in `index.ts`.
4. Add a public output only when operators need one; never rename an existing output key
   (`web`, `api` are a compatibility contract — see `OUTPUT_KEYS`).

### Throttle a specific route harder

`services/gateway.ts` registers a single `$default` route because ASP.NET owns routing. To
throttle one path (e.g. an anonymous write), add an explicit `aws.apigatewayv2.Route` with
that route key plus a matching entry in the stage's `routeSettings`, and add both logical
names to `names.ts`. Note AWS rejects route keys with an empty path segment, so a
trailing-slash variant cannot be registered — it falls through to `$default`.

## Change checklist

- `npm run infra:check` — TypeScript-validates this directory + the entry point (no AWS
  access; needs `.sst/platform/` types, which any prior `sst` command installs).
- `node scripts/deploy.mjs test --dry-run` — validates the secret manifest against the
  local dotenv files without touching AWS.
- `npm run diff -- --stage test` — preview against real state; investigate every proposed
  replacement or IAM change. Zero changes expected from a pure refactor.
- Preserve logical names and never add a component parent unless a deliberate state
  migration is planned.
- Update `DEPLOY.md` when topology, trust boundaries, or the output contract change.
- Use the `deploy` skill for any real test/prod deployment.
