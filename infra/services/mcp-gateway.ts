import type { StageSettings } from "../config/stages";
import { LOGICAL_NAMES } from "../names";
import { ACCESS_LOG_FORMAT, withoutTrailingSlashes } from "../shared/http-api";

// Aggregate account-wide throttle for the MCP endpoint (best-effort — not per-IP). An MCP
// session is a handful of requests per tool call, so this is a runaway-cost backstop rather
// than a capacity plan — same role as the API's.
const DEFAULT_THROTTLE = { rateRps: 20, burst: 40 };

const CORS_MAX_AGE_SECONDS = 600;

interface McpGatewayOptions {
  readonly settings: StageSettings;
  readonly mcpLambda: aws.lambda.Function;
}

// The MCP server's own public edge — a second HTTP API rather than extra routes on the API's
// gateway. Two reasons: the OAuth discovery path (`/.well-known/oauth-protected-resource/mcp`)
// would collide with the API's `$default` catch-all, and a separate origin keeps the connector
// URL, throttle, and access log for the agent surface independent of the app's.
//
// CORS is wildcard here on EVERY stage, unlike the API (whose prod origins must be named, and
// whose deploy is blocked until they are). That difference is deliberate, not an oversight:
// this endpoint is an OAuth 2.0 protected resource authenticated by a bearer token in the
// Authorization header, never by cookies, and `allowCredentials` stays off — so a wildcard
// grants a hostile origin nothing it could not get with curl. Browser-based MCP clients (the
// MCP Inspector, web-hosted connectors) need it to complete the handshake at all.
export function createMcpGateway(options: McpGatewayOptions) {
  const httpApi = new aws.apigatewayv2.Api(LOGICAL_NAMES.mcpHttpApi, {
    protocolType: "HTTP",
    corsConfiguration: {
      allowOrigins: ["*"],
      // DELETE terminates a streamable-HTTP session; the server runs stateless today but the
      // method is part of the transport, so clients may send it.
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: [
        "authorization",
        "content-type",
        "mcp-protocol-version",
        "mcp-session-id",
        "last-event-id",
      ],
      // Without these two the browser hides the headers the client needs: the 401's
      // `WWW-Authenticate` is where OAuth discovery starts, and `mcp-session-id` is how a
      // stateful transport would resume.
      exposeHeaders: ["www-authenticate", "mcp-session-id"],
      maxAge: CORS_MAX_AGE_SECONDS,
    },
  });

  const integration = new aws.apigatewayv2.Integration(LOGICAL_NAMES.mcpHttpApiIntegration, {
    apiId: httpApi.id,
    integrationType: "AWS_PROXY",
    integrationUri: options.mcpLambda.invokeArn,
    integrationMethod: "POST",
    // Matches Mangum's event parsing in mcp/server.py.
    payloadFormatVersion: "2.0",
  });

  // One catch-all route: Starlette owns routing inside the app, and the paths that matter
  // (`/mcp`, `/health`, and the `/.well-known/oauth-protected-resource/*` discovery
  // documents) all have to reach it.
  const defaultRoute = new aws.apigatewayv2.Route(LOGICAL_NAMES.mcpHttpApiDefaultRoute, {
    apiId: httpApi.id,
    routeKey: "$default",
    target: $interpolate`integrations/${integration.id}`,
  });

  const accessLogs = new aws.cloudwatch.LogGroup(LOGICAL_NAMES.mcpHttpApiAccessLogs, {
    retentionInDays: options.settings.accessLogRetentionDays,
  });

  new aws.apigatewayv2.Stage(
    LOGICAL_NAMES.mcpHttpApiStage,
    {
      apiId: httpApi.id,
      // The $default stage serves at the endpoint root, so the connector URL is a clean
      // `${endpoint}/mcp` with no stage prefix — and, just as importantly, the OAuth
      // metadata path the spec fixes at `/.well-known/…` is actually at the root.
      name: "$default",
      autoDeploy: true,
      defaultRouteSettings: {
        throttlingRateLimit: DEFAULT_THROTTLE.rateRps,
        throttlingBurstLimit: DEFAULT_THROTTLE.burst,
      },
      accessLogSettings: {
        destinationArn: accessLogs.arn,
        format: ACCESS_LOG_FORMAT,
      },
    },
    // Route settings referencing a route that doesn't exist yet fail UpdateStage.
    { dependsOn: [defaultRoute] },
  );

  // Allow only API Gateway (this API, any stage/route) to invoke the Lambda.
  new aws.lambda.Permission(LOGICAL_NAMES.mcpHttpApiInvokePermission, {
    action: "lambda:InvokeFunction",
    function: options.mcpLambda.name,
    principal: "apigateway.amazonaws.com",
    sourceArn: $interpolate`${httpApi.executionArn}/*/*`,
  });

  const baseUrl = httpApi.apiEndpoint.apply(withoutTrailingSlashes);

  // `connectorUrl` is what a human pastes into an MCP client — the base URL is only ever
  // useful with `/mcp` on the end, so the stack hands out the finished thing.
  return Object.freeze({
    httpApi,
    baseUrl,
    connectorUrl: baseUrl.apply((url) => `${url}/mcp`),
  });
}
