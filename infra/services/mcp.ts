import type { InfrastructureSecrets } from "../config/secrets";
import { LOGICAL_NAMES } from "../names";

interface McpServiceOptions {
  readonly artifactDir: string;
  readonly secrets: InfrastructureSecrets;
  readonly role: aws.iam.Role;
  readonly apiBaseUrl: $util.Output<string>;
}

// The FastMCP server (mcp/) on the managed `python3.13` Lambda runtime, invoked ONLY through
// its own API Gateway HTTP API (services/mcp-gateway.ts) — no Function URL, same stance as
// the .NET API. `server.handler` is the Mangum adapter in mcp/server.py, which speaks the
// gateway integration's payload format 2.0.
//
// Note what is NOT here: no OAuth client id/secret. Clerk is the authorization server and MCP
// clients register themselves with it via Dynamic Client Registration, so the only Clerk value
// this function needs is the public issuer — reused from the existing ClerkAuthority secret,
// the very same value the .NET API validates tokens against. That shared issuer is what lets
// the MCP forward a caller's token straight through to the API.
export function createMcpService(options: McpServiceOptions) {
  const lambda = new aws.lambda.Function(LOGICAL_NAMES.mcpFunction, {
    runtime: "python3.13",
    architectures: ["arm64"], // must match the wheels in artifacts/python-lambda.ts
    handler: "server.handler",
    code: new $util.asset.FileArchive(options.artifactDir),
    role: options.role.arn,
    // Python cold starts are cheap next to .NET's; 512 MB is enough for the ASGI app plus
    // the JWKS fetch, and more memory would mostly buy CPU this workload never uses.
    memorySize: 512,
    // Matches the HTTP API's 30s integration ceiling — a longer Lambda timeout could only
    // produce 504s the caller already gave up on.
    timeout: 30,
    environment: {
      variables: {
        // The Clerk Frontend API URL — OAuth issuer + JWKS source for token validation.
        CLERK_ISSUER: options.secrets.clerkAuthority.value,
        // The API the token-forwarding tools call. Server-to-server over the public gateway
        // (both are Lambdas with no VPC), so it goes out over TLS like any other client.
        BACKEND_URL: options.apiBaseUrl,
        // SERVER_BASE_URL is deliberately UNSET: a Lambda cannot reference the URL it is
        // reached at without a circular dependency, so the app self-adapts its OAuth
        // discovery URLs per request instead (mcp/looped_in_mcp/middleware.py). Setting it
        // would pin a fixed origin — correct only behind a stable custom domain.
      },
    },
  });

  return Object.freeze({ lambda });
}
