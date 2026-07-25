import { execSync } from "node:child_process";
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

  execSync(
    `dotnet publish "${project}" ` +
      "-c Release -r linux-arm64 --no-self-contained " +
      `-o "${apiDir}"`,
    { stdio: "inherit" },
  );

  return Object.freeze({ apiDir });
}
