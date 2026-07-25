import type { StageSettings } from "../config/stages";
import { LOGICAL_NAMES } from "../names";

// Aggregate account-wide throttle for the API (best-effort — not per-IP). The stack scales
// to zero, so this is mostly a runaway-cost backstop, not a capacity plan.
const DEFAULT_THROTTLE = { rateRps: 20, burst: 40 };

// Browser preflight cache, seconds. Only matters once something calls the API from the
// browser; `/me` is a server-side call today.
const CORS_MAX_AGE_SECONDS = 600;

interface ApiGatewayOptions {
  readonly settings: StageSettings;
  readonly apiLambda: aws.lambda.Function;
}

// The throttled, access-logged public edge — the ONLY way into the API Lambda. A Lambda
// Function URL would be one fewer resource, but it has no request throttling, no access
// logs, and no place to attach an authorizer, WAF, or custom domain later; the gateway is
// the standard-practice edge and this stack is born with it rather than migrating later.
//
// CORS is configured HERE, not in the app: the .NET API registers no CORS middleware, so
// there is exactly one layer emitting Access-Control-Allow-* headers. If CORS middleware is
// ever added to Program.cs, drop it from one side or the other — two layers emit duplicate
// headers and browsers reject the response.
export function createApiGateway(options: ApiGatewayOptions) {
  const httpApi = new aws.apigatewayv2.Api(LOGICAL_NAMES.httpApi, {
    protocolType: "HTTP",
    corsConfiguration: {
      allowOrigins: [...options.settings.corsAllowOrigins],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      // Enough for a bearer token + JSON body. Add headers explicitly as the API grows;
      // allowCredentials stays off (Clerk tokens travel in the Authorization header, not
      // cookies, and "*" origins are incompatible with credentialed requests anyway).
      allowHeaders: ["authorization", "content-type"],
      maxAge: CORS_MAX_AGE_SECONDS,
    },
  });

  const integration = new aws.apigatewayv2.Integration(LOGICAL_NAMES.httpApiIntegration, {
    apiId: httpApi.id,
    integrationType: "AWS_PROXY",
    integrationUri: options.apiLambda.invokeArn,
    integrationMethod: "POST",
    // Matches AddAWSLambdaHosting(LambdaEventSource.HttpApi) in backend Program.cs.
    payloadFormatVersion: "2.0",
  });

  // One catch-all route: ASP.NET owns routing, so every path/method proxies through and the
  // minimal-API endpoint map stays the single source of truth for what exists.
  // Caveat to verify at the first browser-side call: API Gateway answers CORS preflight
  // itself, but the interaction between that and a $default route that also matches OPTIONS
  // is undocumented. Nothing calls the API from the browser today (`/me` is server-side), so
  // if a preflight ever 404s here, add an explicit `OPTIONS /{proxy+}` route or CORS
  // middleware in Program.cs — and if the latter, drop corsConfiguration above.
  const defaultRoute = new aws.apigatewayv2.Route(LOGICAL_NAMES.httpApiDefaultRoute, {
    apiId: httpApi.id,
    routeKey: "$default",
    target: $interpolate`integrations/${integration.id}`,
  });

  const accessLogs = new aws.cloudwatch.LogGroup(LOGICAL_NAMES.httpApiAccessLogs, {
    retentionInDays: options.settings.accessLogRetentionDays,
  });

  // Structured access-log line (JSON.stringify keeps it single-line, as API Gateway
  // requires). No headers, tokens, query strings, or bodies — sourceIp is a $context
  // variable (not a header) kept for abuse investigation, bounded by the log retention.
  const accessLogFormat = JSON.stringify({
    requestId: "$context.requestId",
    requestTime: "$context.requestTime",
    httpMethod: "$context.httpMethod",
    routeKey: "$context.routeKey",
    path: "$context.path",
    status: "$context.status",
    responseLatencyMs: "$context.responseLatency",
    integrationStatus: "$context.integrationStatus",
    integrationLatencyMs: "$context.integrationLatency",
    integrationErrorMessage: "$context.integrationErrorMessage",
    errorType: "$context.error.responseType",
    errorMessage: "$context.error.message",
    sourceIp: "$context.identity.sourceIp",
  });

  new aws.apigatewayv2.Stage(
    LOGICAL_NAMES.httpApiStage,
    {
      apiId: httpApi.id,
      // The $default stage serves at the endpoint root: rawPath carries no stage prefix, so
      // the API's own routes (/me, /db/ping, …) match unchanged.
      name: "$default",
      autoDeploy: true,
      defaultRouteSettings: {
        throttlingRateLimit: DEFAULT_THROTTLE.rateRps,
        throttlingBurstLimit: DEFAULT_THROTTLE.burst,
      },
      accessLogSettings: {
        destinationArn: accessLogs.arn,
        format: accessLogFormat,
      },
    },
    // Route settings referencing a route that doesn't exist yet fail UpdateStage.
    { dependsOn: [defaultRoute] },
  );

  // Allow only API Gateway (this API, any stage/route) to invoke the Lambda.
  new aws.lambda.Permission(LOGICAL_NAMES.httpApiInvokePermission, {
    action: "lambda:InvokeFunction",
    function: options.apiLambda.name,
    principal: "apigateway.amazonaws.com",
    sourceArn: $interpolate`${httpApi.executionArn}/*/*`,
  });

  // execute-api endpoints have no trailing slash; strip defensively so `${base}/me` stays clean.
  const baseUrl = httpApi.apiEndpoint.apply((url) => url.replace(/\/+$/, ""));

  return Object.freeze({ httpApi, baseUrl });
}
