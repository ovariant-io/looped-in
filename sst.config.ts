/// <reference path="./.sst/platform/config.d.ts" />

// Where AWS Budgets cost alerts are emailed. Change before sharing this repo.
const ALERT_EMAIL = "prabath.udakandage@gmail.com";
// Monthly spend ceiling for the alarm (USD). Cheap by design — this stack scales to zero,
// so anything climbing toward this number means something is misconfigured.
const MONTHLY_BUDGET_USD = "10";

export default $config({
  app(input) {
    return {
      name: "looped-in",
      // Stage names match the env files: local | test | prod (see scripts/deploy.mjs).
      // Tear everything down on non-prod stages; keep prod resources on `sst remove`.
      removal: input?.stage === "prod" ? "retain" : "remove",
      protect: input?.stage === "prod",
      home: "aws",
      providers: {
        // us-east-1 is the cheapest region and keeps the CloudFront/Lambda story simple.
        aws: { region: "us-east-1" },
      },
    };
  },

  async run() {
    // Top-level imports aren't allowed in sst.config.ts — import inside run().
    const { execSync } = await import("node:child_process");
    const path = await import("node:path");

    // ---- Secrets (set with `npx sst secret set <Name> <value>` per stage) -------------------
    // Encrypted in SSM Parameter Store; never committed. Empty defaults stay optional.
    const databaseUrl = new sst.Secret("DatabaseUrl"); // Neon postgresql:// URL
    const clerkAuthority = new sst.Secret("ClerkAuthority"); // Clerk Frontend API URL
    const clerkAuthorizedParties = new sst.Secret("ClerkAuthorizedParties", "");
    const clerkPublishableKey = new sst.Secret("ClerkPublishableKey");
    const clerkSecretKey = new sst.Secret("ClerkSecretKey");

    // ---- Build the .NET 10 API for Lambda ---------------------------------------------------
    // SST's serverless Function component is Node-only, so the API is wired with raw Pulumi
    // (`aws.*`) resources instead. We publish a framework-dependent, arm64 build that the
    // managed `dotnet10` Lambda runtime executes. Built every `sst deploy`/`diff` so the
    // FileArchive below always points at a fresh artifact (local dev uses docker-compose, not this).
    // Anchor at the project root. Pulumi's FileArchive resolves a *relative* path against the
    // compiled config's location (.sst/platform/), NOT the repo root — so a bare "backend/…"
    // string resolves to .sst/platform/backend/… and fails with "no such file or directory".
    // SST's own components resolve assets the same way: path.join($cli.paths.root, …).
    const apiProject = path.join($cli.paths.root, "backend/LoopedIn.Api/LoopedIn.Api.csproj");
    const apiPublishDir = path.join($cli.paths.root, "backend/LoopedIn.Api/.lambda-publish");
    execSync(
      `dotnet publish "${apiProject}" ` +
        "-c Release -r linux-arm64 --no-self-contained " +
        `-o "${apiPublishDir}"`,
      { stdio: "inherit" },
    );

    // Execution role: CloudWatch Logs only. No VPC, so no NAT — the API reaches Neon and Clerk
    // over the public internet with TLS. (This is the single biggest "silent billing" avoidance.)
    const apiRole = new aws.iam.Role("LoopedInApiRole", {
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Action: "sts:AssumeRole",
            Effect: "Allow",
            Principal: { Service: "lambda.amazonaws.com" },
          },
        ],
      }),
    });
    new aws.iam.RolePolicyAttachment("LoopedInApiLogs", {
      role: apiRole.name,
      policyArn:
        "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
    });

    const api = new aws.lambda.Function("LoopedInApi", {
      runtime: "dotnet10",
      architectures: ["arm64"], // cheaper + faster than x86_64
      handler: "LoopedIn.Api", // executable assembly name (top-level Program)
      code: new $util.asset.FileArchive(apiPublishDir),
      role: apiRole.arn,
      // More memory = more CPU = shorter .NET cold start. 1024 MB is a good cost/latency balance.
      memorySize: 1024,
      timeout: 30,
      environment: {
        variables: {
          ASPNETCORE_ENVIRONMENT: "Production",
          DATABASE_URL: databaseUrl.value,
          Clerk__Authority: clerkAuthority.value,
          Clerk__AuthorizedParties: clerkAuthorizedParties.value,
        },
      },
    });

    // Public Function URL (no API Gateway, no ALB — both are avoidable fixed costs).
    const apiUrl = new aws.lambda.FunctionUrl("LoopedInApiUrl", {
      functionName: api.name,
      authorizationType: "NONE", // app does its own Clerk JWT validation
      cors: {
        // TODO: tighten allowOrigins to the web.url once browser-side calls are added.
        // Today /me is a server-side call so this is only exercised by direct API hits.
        allowOrigins: ["*"],
        allowMethods: ["*"],
        allowHeaders: ["*"],
      },
    });
    // A FunctionUrl with authType NONE still needs an explicit public-invoke permission.
    new aws.lambda.Permission("LoopedInApiUrlPublic", {
      action: "lambda:InvokeFunctionUrl",
      function: api.name,
      principal: "*",
      functionUrlAuthType: "NONE",
    });

    // Function URLs end with a trailing slash; strip it so `${BACKEND_URL}/me` stays clean.
    const apiBase = apiUrl.functionUrl.apply((u) => u.replace(/\/+$/, ""));

    // ---- Next.js frontend (OpenNext → Lambda + CloudFront + S3, all scale to zero) ----------
    const web = new sst.aws.Nextjs("LoopedInWeb", {
      path: "frontend",
      server: { architecture: "arm64" },
      environment: {
        // Server-side call over the Compose network locally; over the Function URL in the cloud.
        BACKEND_URL: apiBase,
        NEXT_PUBLIC_API_URL: apiBase,
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: clerkPublishableKey.value,
        CLERK_SECRET_KEY: clerkSecretKey.value,
        // Stable app routes (match app/sign-in, app/sign-up + the `clerk init` defaults).
        NEXT_PUBLIC_CLERK_SIGN_IN_URL: "/sign-in",
        NEXT_PUBLIC_CLERK_SIGN_UP_URL: "/sign-up",
        NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL: "/",
        NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL: "/",
      },
    });

    // ---- Cost guardrail: email alarm so nothing bills silently -------------------------------
    new aws.budgets.Budget("LoopedInCostGuard", {
      budgetType: "COST",
      limitAmount: MONTHLY_BUDGET_USD,
      limitUnit: "USD",
      timeUnit: "MONTHLY",
      notifications: [
        {
          comparisonOperator: "GREATER_THAN",
          threshold: 50, // alert at 50% of actual spend
          thresholdType: "PERCENTAGE",
          notificationType: "ACTUAL",
          subscriberEmailAddresses: [ALERT_EMAIL],
        },
        {
          comparisonOperator: "GREATER_THAN",
          threshold: 100, // alert when forecast to exceed the cap
          thresholdType: "PERCENTAGE",
          notificationType: "FORECASTED",
          subscriberEmailAddresses: [ALERT_EMAIL],
        },
      ],
    });

    return {
      web: web.url,
      api: apiUrl.functionUrl,
    };
  },
});
