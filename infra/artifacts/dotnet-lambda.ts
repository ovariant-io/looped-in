import { execFileSync } from "node:child_process";
import { existsSync, rmSync, statSync } from "node:fs";
import path from "node:path";

export interface DotnetLambdaArtifacts {
  readonly apiDir: string;
}

// SST's serverless Function component is Node-only, so the .NET API is wired with raw
// Pulumi (`aws.*`) resources. We publish a framework-dependent arm64 build that the managed
// `dotnet10` Lambda runtime executes, on every deploy/diff so the FileArchive in the service
// modules always points at a fresh artifact. Requires a host .NET 10 SDK (see DEPLOY.md).
// Paths are anchored at the repo root because Pulumi's FileArchive resolves relative paths
// against the compiled config's location (.sst/platform/), not the repo root — a bare
// "backend/…" string resolves to .sst/platform/backend/… and fails with "no such file".
// Local dev uses docker-compose, not this.
export function buildDotnetLambdaArtifacts(repoRoot: string): DotnetLambdaArtifacts {
  const project = path.join(repoRoot, "backend/LoopedIn.Api/LoopedIn.Api.csproj");
  const apiDir = path.join(repoRoot, "backend/LoopedIn.Api/.lambda-publish");

  // Rebuild from scratch: `dotnet publish -o` overwrites the files it produces but never
  // prunes ones it doesn't, so a DLL from a since-removed PackageReference would survive here
  // and ship in every subsequent zip — silently, and long after the change that orphaned it.
  // Same hazard and same fix as artifacts/python-lambda.ts.
  rmSync(apiDir, { recursive: true, force: true });

  // execFileSync, not execSync: the arguments are passed to the process directly rather than
  // through a shell, so a repo path containing a space or a quote can't reshape the command.
  execFileSync(
    "dotnet",
    [
      "publish",
      project,
      "-c",
      "Release",
      "-r",
      "linux-arm64",
      "--no-self-contained",
      "-o",
      apiDir,
    ],
    { stdio: "inherit" },
  );

  // Cheap guard against a silently empty/partial artifact — a Lambda that unzips without its
  // entry assembly fails at invoke time, long after the deploy reports success. Mirrors the
  // equivalent check in artifacts/python-lambda.ts.
  const entryAssembly = path.join(apiDir, "LoopedIn.Api.dll");
  if (!existsSync(entryAssembly) || statSync(entryAssembly).size === 0) {
    throw new Error(`API Lambda artifact is missing LoopedIn.Api.dll (looked in ${apiDir})`);
  }

  return Object.freeze({ apiDir });
}
