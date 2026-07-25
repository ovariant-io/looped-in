#!/usr/bin/env node
// Deploy Looped In to AWS with SST.
//
// Loads secrets from the per-environment dotenv files into SST (SSM), then deploys —
// so you never hand-run `sst secret set`. The env name doubles as the SST stage.
//
//   node scripts/deploy.mjs <local|test|prod> [-- extra sst flags]
//   npm run deploy:test
//
// Reads (whichever exist):
//   backend/.env.<env>   → DATABASE_URL, Clerk__Authority, Clerk__AuthorizedParties
//   frontend/.env.<env>  → NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY
//
// The actual `sst deploy` runs `dotnet publish` for the API Lambda, so a host .NET 10 SDK
// is required (see DEPLOY.md). `--dry-run` resolves secrets and prints without it.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ENVS = ["local", "test", "prod"];
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const rawArgs = process.argv.slice(2);
const dryRun = rawArgs.includes("--dry-run"); // validate + print, never touch AWS
const positional = rawArgs.filter((a) => a !== "--dry-run");
const env = positional[0];
const passthrough = positional.slice(1); // forwarded to `sst deploy`

if (!ENVS.includes(env)) {
  console.error(
    `Usage: node scripts/deploy.mjs <${ENVS.join("|")}> [--dry-run] [-- extra sst flags]`,
  );
  process.exit(1);
}

// SST secret name  ←  { which app's .env file, which key in it, required? }
// Shared manifest with the infra modules: infra/config/secrets.ts declares the matching
// sst.Secret handles from the same file, so the two sides can't drift.
const SECRETS = JSON.parse(
  readFileSync(join(repoRoot, "infra", "config", "secrets.json"), "utf8"),
);

/** Minimal dotenv parser: `KEY=value`, `#` comments, optional surrounding quotes. */
function parseDotenv(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const sources = {
  backend: parseDotenv(join(repoRoot, "backend", `.env.${env}`)),
  frontend: parseDotenv(join(repoRoot, "frontend", `.env.${env}`)),
};

const resolved = [];
const missing = [];
for (const s of SECRETS) {
  const val = sources[s.app][s.key];
  if (val === undefined || val === "") {
    if (s.required) missing.push(`${s.name}  ← ${s.app}/.env.${env} : ${s.key}`);
    continue;
  }
  resolved.push([s.name, val]);
}

if (missing.length) {
  console.error(
    `\n✗ Missing required secret(s) for stage "${env}":\n  - ${missing.join("\n  - ")}\n`,
  );
  process.exit(1);
}

if (dryRun) {
  console.log(
    `DRY RUN — stage "${env}": would load ${resolved.length} secret(s): ${resolved
      .map(([k]) => k)
      .join(", ")}`,
  );
  console.log(
    `DRY RUN — would run: sst deploy --stage ${env}${
      passthrough.length ? " " + passthrough.join(" ") : ""
    }`,
  );
  process.exit(0);
}

function sst(args) {
  execFileSync("npx", ["sst", ...args], { stdio: "inherit", cwd: repoRoot });
}

/**
 * Renders one `KEY=value` line for the temp dotenv `sst secret load` reads.
 *
 * Always double-quoted, with `\`, `"`, and newlines escaped. parseDotenv above strips
 * surrounding quotes on the way in, so writing the value back bare would corrupt anything
 * containing a space, a `#`, or a quote — and connection strings and Clerk keys are exactly
 * the kind of value that carries those. A secret mangled here fails at runtime, in the
 * deployed stage, as an authentication error that points nowhere near this line.
 */
function toDotenvLine(key, value) {
  const escaped = String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n");
  return `${key}="${escaped}"`;
}

// Load secrets in one call via a short-lived temp dotenv (mode 0600), then shred it.
console.log(`→ Loading ${resolved.length} secret(s) into SST stage "${env}"…`);
const dir = mkdtempSync(join(tmpdir(), "looped-in-secrets-"));
const secretFile = join(dir, "secrets.env");
let status = 0;
try {
  writeFileSync(
    secretFile,
    resolved.map(([k, v]) => toDotenvLine(k, v)).join("\n") + "\n",
    { mode: 0o600 },
  );
  sst(["secret", "load", secretFile, "--stage", env]);
} catch (e) {
  status = typeof e.status === "number" ? e.status : 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (status) process.exit(status);

console.log(`\n→ Deploying stage "${env}"…`);
try {
  sst(["deploy", "--stage", env, ...passthrough]);
} catch (e) {
  process.exit(typeof e.status === "number" ? e.status : 1);
}
