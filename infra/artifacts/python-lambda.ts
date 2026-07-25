import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

export interface PythonLambdaArtifacts {
  readonly mcpDir: string;
}

// The interpreter used to resolve wheels. It does NOT have to match the host platform —
// the flags below cross-resolve for Lambda's arm64 Linux — but pip must be new enough to
// honour them, so the deploy host needs python3.13 on PATH (see DEPLOY.md).
const PYTHON = "python3.13";
const LAMBDA_RUNTIME_VERSION = "3.13"; // keep in sync with services/mcp.ts `runtime`
const LAMBDA_PLATFORM_TAG = "manylinux2014_aarch64"; // keep in sync with `architectures`

// Files that must never reach the deployed zip: local dotenv state and bytecode compiled
// for the *host* platform.
function isExcludedSource(name: string): boolean {
  return (
    name === "__pycache__" ||
    name === ".venv" ||
    name === ".env" ||
    name.startsWith(".env.") ||
    path.extname(name) === ".pyc"
  );
}

// Builds the MCP server's Lambda zip contents: hash-locked dependencies cross-installed for
// Lambda's python3.13/arm64, plus the server source. Runs on every deploy/diff so the
// FileArchive in services/mcp.ts always points at a fresh artifact — the same
// build-on-compose approach as artifacts/dotnet-lambda.ts, and for the same reason (SST's
// serverless Function component is Node-only, so the Python function is raw Pulumi).
// Paths are anchored at the repo root because Pulumi's FileArchive resolves relative paths
// against the compiled config's location (.sst/platform/), not the repo root.
// Local dev uses docker compose (`--profile mcp`), not this.
export function buildPythonLambdaArtifacts(repoRoot: string): PythonLambdaArtifacts {
  const mcpRoot = path.join(repoRoot, "mcp");
  const lockFile = path.join(mcpRoot, "requirements-lambda.lock");
  const entrypoint = path.join(mcpRoot, "server.py");
  const packageDir = path.join(mcpRoot, "looped_in_mcp");
  const publishDir = path.join(mcpRoot, ".lambda-publish");

  if (!existsSync(lockFile)) {
    throw new Error(
      `Missing MCP Lambda dependency lock: ${lockFile}. Regenerate it with the ` +
        "`uv pip compile` command documented at the top of mcp/requirements.txt.",
    );
  }

  // Rebuild from scratch: pip --target merges into an existing tree, so a stale install
  // could otherwise survive a dependency removal and ship in the zip forever.
  rmSync(publishDir, { recursive: true, force: true });
  mkdirSync(publishDir, { recursive: true });

  // --require-hashes: every wheel is verified against the lock.
  // --platform/--python-version/--implementation + --only-binary: resolve Lambda's wheels
  //   (arm64 Linux, CPython 3.13) regardless of the machine running the deploy.
  // --no-compile: .pyc built here would be for the host, and Lambda's read-only filesystem
  //   makes them useless anyway.
  execFileSync(
    PYTHON,
    [
      "-m",
      "pip",
      "install",
      "--quiet",
      "--require-hashes",
      "--platform",
      LAMBDA_PLATFORM_TAG,
      "--only-binary=:all:",
      "--python-version",
      LAMBDA_RUNTIME_VERSION,
      "--implementation",
      "cp",
      "--no-compile",
      "--target",
      publishDir,
      "-r",
      lockFile,
    ],
    { stdio: "inherit" },
  );

  cpSync(entrypoint, path.join(publishDir, "server.py"));
  cpSync(packageDir, path.join(publishDir, "looped_in_mcp"), {
    recursive: true,
    filter: (source) => !isExcludedSource(path.basename(source)),
  });

  // Cheap guard against a silently empty/partial artifact — a Lambda that unzips without
  // its handler fails at invoke time, long after the deploy reports success.
  for (const required of ["server.py", path.join("looped_in_mcp", "app.py")]) {
    const file = path.join(publishDir, required);
    if (!existsSync(file) || statSync(file).size === 0) {
      throw new Error(`MCP Lambda artifact is missing ${required}`);
    }
  }

  return Object.freeze({ mcpDir: publishDir });
}
