// Shared pieces of an API Gateway HTTP API edge. Both public edges in this stack — the
// API's (services/gateway.ts) and the MCP server's (services/mcp-gateway.ts) — are the same
// shape: a $default stage + $default route in front of one Lambda, throttled and
// access-logged. Only the CORS policy and the throttle numbers differ, so those stay in the
// service modules and the invariant bits live here.
//
// Deliberately NOT a factory that creates the resources: each edge declares its own
// resources under its own frozen logical names (infra/names.ts), so a shared constructor
// would only obscure which URN belongs to which service.

// Structured access-log line (JSON.stringify keeps it single-line, as API Gateway requires).
// No headers, tokens, query strings, or bodies — sourceIp is a $context variable (not a
// header) kept for abuse investigation, bounded by the log-group retention.
export const ACCESS_LOG_FORMAT = JSON.stringify({
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

// execute-api endpoints have no trailing slash; strip defensively so `${base}/me` and
// `${base}/mcp` stay clean however the endpoint is rendered.
export function withoutTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}
