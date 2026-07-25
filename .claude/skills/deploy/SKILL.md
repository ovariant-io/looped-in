---
name: deploy
description: Deploy the Looped In stack to AWS for a given environment (local | test | prod) via SST. Use when asked to deploy, ship, release, or push the app to AWS for a specific env. Loads secrets from the per-env .env files, dry-runs first, confirms, then runs `sst deploy`. This performs a REAL, billable deployment — never run it as a side effect of another task.
argument-hint: <local|test|prod>
---

# Deploy (SST → AWS)

Deploy Looped In to AWS for **one environment**, passed as the skill argument: `local`, `test`, or
`prod`. This wraps `scripts/deploy.mjs`, which reads the per-env dotenv files, loads their values
into SST secrets (SSM), then runs `sst deploy`. The **stage name equals the env name**.

Run all commands **from the repo root**.

## ⚠️ This is a real deployment

`npm run deploy:<env>` / `scripts/deploy.mjs <env>` creates billable AWS resources against
whatever account the active credentials point at. It is **not** a dry run.

- **Never** trigger a deploy as a side effect of testing, verifying, or "just checking" the script.
- To exercise the script safely, **always use `--dry-run`** (it resolves secrets and prints the
  plan without touching AWS).
- Proceed to the real deploy **only after the user explicitly confirms** (see Step 4).

## Inputs

- **env** — the skill argument. Must be `local`, `test`, or `prod`. If it is missing or invalid,
  ask the user which environment before doing anything.
- `local` is normally for docker-compose dev; deploying it creates a personal cloud stage. `prod`
  is `protect`ed and its resources are **retained** on `sst remove`.

## Steps

1. **Resolve env** from the argument. Stop and ask if it is not `local`/`test`/`prod`.
2. **Preflight** (repo root): if `node_modules/.bin/sst` is missing, run `npm install`. (AWS
   credentials and the .NET 10 SDK are assumed — if the deploy later errors on credentials, tell
   the user to run `aws configure` / set up SSO.)
3. **Dry run first** — always:
   ```bash
   node scripts/deploy.mjs <env> --dry-run
   ```
   - On success it prints the secret **names** that will load (never values) and the exact deploy
     command. Show this to the user.
   - If it **fails fast** (missing required secret), it names the exact `<app>/.env.<env>` key.
     Report that and **stop** — the fix is to populate that key, not to retry.
4. **Confirm** — show the user: target env/stage, that this is a real billable deploy, and (for
   `prod`) that it is protected/retained. Get an explicit go-ahead. Do not deploy without it.
5. **Deploy**:
   ```bash
   npm run deploy:<env>        # e.g. npm run deploy:test
   # local has no npm alias: node scripts/deploy.mjs local
   ```
   Stream the output. The deploy publishes the .NET API for Lambda, loads the secrets, and brings
   up the stack.
6. **Report outputs** — surface the printed `web` (CloudFront URL) and `api` (Lambda Function URL).
7. **On failure** — surface the exact error verbatim; do **not** blindly retry. If resources were
   partially created, the clean recovery is `npx sst remove --stage <env>`.

## Secrets, by env

`scripts/deploy.mjs` maps these (all `.env.<env>` files are gitignored):

| SST secret | Source | Key | Required |
| --- | --- | --- | --- |
| `DatabaseUrl` | `backend/.env.<env>` | `DATABASE_URL` | ✅ |
| `ClerkAuthority` | `backend/.env.<env>` | `Clerk__Authority` | ✅ |
| `ClerkAuthorizedParties` | `backend/.env.<env>` | `Clerk__AuthorizedParties` | optional |
| `ClerkPublishableKey` | `frontend/.env.<env>` | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | ✅ |
| `ClerkSecretKey` | `frontend/.env.<env>` | `CLERK_SECRET_KEY` | ✅ |

## Teardown

```bash
npx sst remove --stage <env>   # prod resources are retained by config; removal is explicit
```

## Notes

- Full cost model, architecture, and tradeoffs live in `DEPLOY.md`.
- Day-to-day **local development is `docker compose up` / `dotnet run` / `npm run dev`** — not this skill.
