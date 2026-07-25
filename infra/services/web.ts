import type { InfrastructureSecrets } from "../config/secrets";
import { LOGICAL_NAMES } from "../names";

interface WebServiceOptions {
  readonly secrets: InfrastructureSecrets;
  readonly apiBaseUrl: $util.Output<string>;
  readonly mcpConnectorUrl: $util.Output<string>;
}

// Next.js frontend: OpenNext → Lambda + CloudFront + S3, all scale to zero.
export function createWebService(options: WebServiceOptions) {
  const web = new sst.aws.Nextjs(LOGICAL_NAMES.web, {
    path: "frontend",
    server: { architecture: "arm64" },
    environment: {
      // Both point at the API Gateway endpoint. BACKEND_URL is the server-side call from
      // app/me/page.tsx (the Compose network locally, the gateway in the cloud);
      // NEXT_PUBLIC_API_URL is the browser-visible base for future client-side calls.
      BACKEND_URL: options.apiBaseUrl,
      NEXT_PUBLIC_API_URL: options.apiBaseUrl,
      // The connector URL the /connect page tells people to paste into their MCP client.
      // Deliberately NOT NEXT_PUBLIC_: those are inlined into the bundle at build time,
      // while this value only exists once the MCP gateway is created. The page reads it
      // server-side during dynamic rendering instead, so it resolves per request.
      MCP_URL: options.mcpConnectorUrl,
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: options.secrets.clerkPublishableKey.value,
      CLERK_SECRET_KEY: options.secrets.clerkSecretKey.value,
      // Stable app routes (match app/sign-in, app/sign-up + the `clerk init` defaults).
      NEXT_PUBLIC_CLERK_SIGN_IN_URL: "/sign-in",
      NEXT_PUBLIC_CLERK_SIGN_UP_URL: "/sign-up",
      NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL: "/",
      NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL: "/",
    },
  });

  return Object.freeze({ web });
}
