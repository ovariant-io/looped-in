# Deploying Looped In to AWS (SST)

A **scale-to-zero** AWS deployment via [SST v3](https://sst.dev). Idle cost is ≈ **$0/mo** —
everything here is pay-per-use, there is **no VPC / NAT Gateway / ALB / Fargate / RDS**, and an
AWS Budgets alarm emails you before anything bills silently.

> ⚠️ `npm run deploy:*` performs a **real deployment** to whatever AWS account your credentials
> point at, and creates billable (though near-zero at idle) resources. It is not a dry run.

## Stages = environments

The stage name matches the dotenv suffix: **`local` · `test` · `prod`**. Each stage is fully
isolated in AWS. `prod` is `protect`ed and its resources are retained on `sst remove`; the
others are torn down completely.

## What gets created

| Piece | AWS resources | Billing |
| --- | --- | --- |
| **Frontend** (`frontend/`) | Next.js via OpenNext → Lambda + CloudFront + S3 (+ SQS/DynamoDB/KV for ISR/cache) | scales to zero |
| **API** (`backend/LoopedIn.Api`) | .NET 10 Lambda (`dotnet10` managed runtime, arm64) | scales to zero |
| **API edge** | API Gateway **HTTP API** (`$default` stage + route) — throttled, access-logged, CORS | pay-per-request |
| **Cost guard** | AWS Budgets alarm (default $10/mo, emails at 50% actual / 100% forecast) | free |
| Postgres | **Neon** — external, not on the AWS bill | — |
| Auth | **Clerk** — external, not on the AWS bill | — |

The API Lambda has **no Function URL**: API Gateway is its only invoke path (a single
`lambda:Permission` scoped to the API's execution ARN). A Function URL is one fewer resource,
but it has no request throttling, no access logs, and nowhere to attach an authorizer, WAF, or
custom domain later — so the stack is born gateway-only rather than migrating to it after
something is already deployed against the old URL.

## Where the infra lives

`sst.config.ts` is a thin entry point; the resource modules live in **`infra/`** — `config/`
(stage settings, secret manifest), `services/` (`api`, `gateway`, `web`), `operations/`,
`shared/`, and `names.ts` (frozen logical names + the output contract). See
[`infra/README.md`](infra/README.md) for ownership, extension recipes, and the change checklist.
`npm run infra:check` typechecks the whole directory without touching AWS.

## Secrets come from your `.env.<env>` files

`scripts/deploy.mjs` reads the per-env dotenv files, pushes the values into SST secrets (SSM,
encrypted), then deploys — so you never hand-run `sst secret set`. It **fails fast** (listing the
missing file/key) before touching AWS if a required secret is absent.

| SST secret | Source file | Key | Required |
| --- | --- | --- | --- |
| `DatabaseUrl` | `backend/.env.<env>` | `DATABASE_URL` | ✅ |
| `ClerkAuthority` | `backend/.env.<env>` | `Clerk__Authority` | ✅ |
| `ClerkAuthorizedParties` | `backend/.env.<env>` | `Clerk__AuthorizedParties` | optional |
| `ClerkPublishableKey` | `frontend/.env.<env>` | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | ✅ |
| `ClerkSecretKey` | `frontend/.env.<env>` | `CLERK_SECRET_KEY` | ✅ |

The table above is generated from **`infra/config/secrets.json`** — the single manifest both
`scripts/deploy.mjs` and `infra/config/secrets.ts` read, so the loader and the `sst.Secret`
handles cannot drift. All `.env.<env>` files are gitignored (only `*.example` templates are
committed). The stable Clerk route URLs (`/sign-in`, `/sign-up`) are set in
`infra/services/web.ts`, not as secrets.

## One-time setup

1. **AWS credentials** — `aws configure` (or SSO). The stack pins **`ap-southeast-2`** (Sydney)
   for every stage — see `AWS_REGION` in `infra/config/stages.ts`.
2. **Toolchain** — Node + the **.NET 10 SDK** (the deploy runs `dotnet publish` for the API).
3. **Install SST** (from the repo root): `npm install`

## Deploy

```bash
npm run deploy:test       # reads backend/.env.test + frontend/.env.test, then deploys stage "test"
npm run deploy:prod       # stage "prod" (protected, resources retained on remove)
npm run deploy -- local   # stage "local" (a personal cloud env; day-to-day local dev uses docker compose)
```

Outputs print the CloudFront `web` URL and the `api` API Gateway endpoint (these two keys are a
compatibility contract — see `OUTPUT_KEYS` in `infra/names.ts`). `npm run diff -- --stage test`
previews changes; `npm run console` opens the dashboard.

`prod` **fails fast before touching AWS** while `STAGE_CONFIG.prod.corsAllowOrigins` is empty or
`"*"` (`infra/config/stages.ts`) — prod must never launch with wildcard CORS. Fill in the real
web origin(s) and the guard clears itself.

**Validate without deploying** — `--dry-run` resolves the secrets (printing names only) and prints
what would run, without touching AWS:

```bash
node scripts/deploy.mjs test --dry-run
```

## Tear down

```bash
npx sst remove --stage test
npx sst remove --stage prod      # prod resources are retained by config; remove is explicit
```

## Notes & tradeoffs

- **Cold starts:** the .NET API sleeps when idle, so the first request after a quiet period
  takes ~1–2s. 1024 MB is set for faster cold starts; raise memory or add SnapStart/a warmer
  if that latency matters.
- **CORS is owned by the gateway, not the app.** The .NET API registers no CORS middleware, so
  exactly one layer emits `Access-Control-Allow-*`. Origins come from the stage map
  (`corsAllowOrigins` in `infra/config/stages.ts`) — `"*"` on local/test, exact origins required
  on prod. If CORS middleware is ever added to `Program.cs`, remove it from one side: two layers
  emit duplicate headers and browsers reject the response.
- **Throttling:** the `$default` stage carries an aggregate 20 rps / 40 burst limit
  (`infra/services/gateway.ts`) as a runaway-cost backstop. It is account-wide, not per-IP.
- **Access logs:** one structured JSON line per request in CloudWatch (30-day retention on
  local/test, 90 on prod). No headers, tokens, query strings, or bodies are logged.
- **Local dev is unchanged** — keep using `docker compose up` / `dotnet run` / `npm run dev`.
- **Cost alarm:** edit `ALERT_EMAIL` / `MONTHLY_BUDGET_USD` in `infra/config/stages.ts`.
