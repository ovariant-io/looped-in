import type { InfrastructureSecrets } from "../config/secrets";
import { LOGICAL_NAMES } from "../names";

interface ApiServiceOptions {
  readonly artifactDir: string;
  readonly secrets: InfrastructureSecrets;
  readonly role: aws.iam.Role;
  readonly documentsBucket: $util.Input<string>;
  readonly documentsPrefix: string;
}

// The .NET 10 API on the managed `dotnet10` Lambda runtime. It is invoked ONLY through the
// API Gateway HTTP API (services/gateway.ts) — there is no Function URL, so the function has
// no public invoke path of its own. Program.cs calls AddAWSLambdaHosting(LambdaEventSource
// .HttpApi), which matches the gateway integration's payload format 2.0.
export function createApiService(options: ApiServiceOptions) {
  const lambda = new aws.lambda.Function(LOGICAL_NAMES.apiFunction, {
    runtime: "dotnet10",
    architectures: ["arm64"], // Graviton: cheaper + faster than x86_64
    handler: "LoopedIn.Api", // executable assembly name (top-level Program)
    code: new $util.asset.FileArchive(options.artifactDir),
    role: options.role.arn,
    // More memory = more CPU = shorter .NET cold start. 1024 MB is a good cost/latency balance.
    memorySize: 1024,
    // Matches the HTTP API's 30s integration ceiling — a longer Lambda timeout could only
    // produce 504s the caller already gave up on.
    timeout: 30,
    environment: {
      variables: {
        ASPNETCORE_ENVIRONMENT: "Production",
        DATABASE_URL: options.secrets.databaseUrl.value,
        Clerk__Authority: options.secrets.clerkAuthority.value,
        Clerk__AuthorizedParties: options.secrets.clerkAuthorizedParties.value,
        // Document storage. Not secrets — a bucket name and a key prefix — so they are plain
        // env vars rather than SSM entries. The double underscore is ASP.NET's separator for a
        // nested configuration key, so these bind to Documents:Bucket / Documents:Prefix.
        // AWS_REGION and the role credentials are injected by the Lambda runtime itself, which
        // is the whole credential story here: the API holds no AWS keys.
        Documents__Bucket: options.documentsBucket,
        Documents__Prefix: options.documentsPrefix,
      },
    },
  });

  return Object.freeze({ lambda });
}
