import { buildDotnetLambdaArtifacts } from "./artifacts/dotnet-lambda";
import { createSecrets } from "./config/secrets";
import { assertStageDeployable, resolveStageSettings } from "./config/stages";
import { LOGICAL_NAMES, type OutputKey } from "./names";
import { createBudget } from "./operations/budget";
import { createApiService } from "./services/api";
import { createApiGateway } from "./services/gateway";
import { createWebService } from "./services/web";
import { createLambdaExecutionRole } from "./shared/iam";

interface ComposeInfrastructureOptions {
  readonly repoRoot: string;
  readonly stage: string;
}

// Composes the deployed graph in dependency order. Plain functions are used deliberately
// so moving declarations between modules never introduces Pulumi component parents or
// changes resource URNs (see infra/README.md).
export function composeInfrastructure(
  options: ComposeInfrastructureOptions,
): Record<OutputKey, unknown> {
  // Resolve per-stage config and the prod guard before any side effects (the dotnet publish
  // below) so a misconfigured stage fails immediately.
  const settings = resolveStageSettings(options.stage);
  assertStageDeployable(settings);

  const secrets = createSecrets();
  const artifacts = buildDotnetLambdaArtifacts(options.repoRoot);

  const role = createLambdaExecutionRole(
    LOGICAL_NAMES.lambdaRole,
    LOGICAL_NAMES.lambdaRoleLogs,
  );

  const api = createApiService({
    artifactDir: artifacts.apiDir,
    secrets,
    role,
  });
  const gateway = createApiGateway({ settings, apiLambda: api.lambda });
  const web = createWebService({ secrets, apiBaseUrl: gateway.baseUrl });
  createBudget(settings);

  return {
    web: web.web.url,
    // The API Gateway HTTP API endpoint — the only public way into the API Lambda.
    api: gateway.baseUrl,
  };
}
