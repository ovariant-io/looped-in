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
| **API** (`backend/LoopedIn.Api`) | .NET 10 Lambda (`dotnet10` managed runtime, arm64) + public Function URL | scales to zero |
| **Cost guard** | AWS Budgets alarm (default $10/mo, emails at 50% actual / 100% forecast) | free |
| Postgres | **Neon** — external, not on the AWS bill | — |
| Auth | **Clerk** — external, not on the AWS bill | — |

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

All `.env.<env>` files are gitignored (only `*.example` templates are committed). The stable
Clerk route URLs (`/sign-in`, `/sign-up`) are set directly in `sst.config.ts`, not as secrets.

## One-time setup

1. **AWS credentials** — `aws configure` (or SSO). The stack pins `us-east-1`.
2. **Toolchain** — Node + the **.NET 10 SDK** (the deploy runs `dotnet publish` for the API).
3. **Install SST** (from the repo root): `npm install`

## Deploy

```bash
npm run deploy:test       # reads backend/.env.test + frontend/.env.test, then deploys stage "test"
npm run deploy:prod       # stage "prod" (protected, resources retained on remove)
npm run deploy -- local   # stage "local" (a personal cloud env; day-to-day local dev uses docker compose)
```

Outputs print the CloudFront `web` URL and the Lambda `api` Function URL. `npm run diff -- --stage test`
previews changes; `npm run console` opens the dashboard.

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
- **CORS:** the Function URL currently allows all origins because the only cross-service call
  today (`/me`) is **server-side**. Tighten `allowOrigins` to the web URL before adding
  browser-side API calls.
- **Local dev is unchanged** — keep using `docker compose up` / `dotnet run` / `npm run dev`.
- **Cost alarm:** edit `ALERT_EMAIL` / `MONTHLY_BUDGET_USD` at the top of `sst.config.ts`.
