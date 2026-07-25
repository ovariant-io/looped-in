import { buildDotnetLambdaArtifacts } from "./artifacts/dotnet-lambda";
import { buildPythonLambdaArtifacts } from "./artifacts/python-lambda";
import { createSecrets } from "./config/secrets";
import { assertStageDeployable, resolveStageSettings } from "./config/stages";
import { LOGICAL_NAMES, type OutputKey } from "./names";
import { createBudget } from "./operations/budget";
import { createApiService } from "./services/api";
import { createApiGateway } from "./services/gateway";
import { createMcpService } from "./services/mcp";
import { createMcpGateway } from "./services/mcp-gateway";
import { createWebService } from "./services/web";
import { createLambdaExecutionRole, grantDocumentsAccess } from "./shared/iam";
import { createStorageBucket, DOCUMENTS_PREFIX } from "./storage/bucket";

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
  const pythonArtifacts = buildPythonLambdaArtifacts(options.repoRoot);

  const role = createLambdaExecutionRole(
    LOGICAL_NAMES.lambdaRole,
    LOGICAL_NAMES.lambdaRoleLogs,
  );

  // The document store now precedes the API, which needs its name at creation time. Ordering is
  // presentational only — Pulumi derives URNs from the logical names in names.ts, not from
  // declaration order — so moving this did not touch any existing resource's identity.
  const storage = createStorageBucket({ settings });
  grantDocumentsAccess(
    LOGICAL_NAMES.apiDocumentsPolicy,
    role,
    storage.bucket.arn,
    DOCUMENTS_PREFIX,
  );

  const api = createApiService({
    artifactDir: artifacts.apiDir,
    secrets,
    role,
    documentsBucket: storage.bucket.name,
    documentsPrefix: DOCUMENTS_PREFIX,
  });
  const gateway = createApiGateway({ settings, apiLambda: api.lambda });

  // The MCP server sits downstream of the API (it forwards the caller's token to it) and
  // upstream of the web app (which shows the connector URL) — hence this position in the
  // order. Its own execution role: separate identity, separate log group, and no shared
  // permissions to inherit if either function is granted something later.
  const mcpRole = createLambdaExecutionRole(
    LOGICAL_NAMES.mcpRole,
    LOGICAL_NAMES.mcpRoleLogs,
  );
  const mcp = createMcpService({
    artifactDir: pythonArtifacts.mcpDir,
    secrets,
    role: mcpRole,
    apiBaseUrl: gateway.baseUrl,
  });
  const mcpGateway = createMcpGateway({ settings, mcpLambda: mcp.lambda });

  const web = createWebService({
    secrets,
    apiBaseUrl: gateway.baseUrl,
    mcpConnectorUrl: mcpGateway.connectorUrl,
  });
  createBudget(settings);

  return {
    web: web.web.url,
    // The API Gateway HTTP API endpoint — the only public way into the API Lambda.
    api: gateway.baseUrl,
    // Auto-generated S3 bucket name — the document store behind /documents.
    bucket: storage.bucket.name,
    // The URL to paste into an MCP client as a custom connector (the /connect page shows it
    // too, for people who never see stack outputs).
    mcp: mcpGateway.connectorUrl,
  };
}
