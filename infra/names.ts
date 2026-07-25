// Frozen logical names for every deployed resource. These are the stable identity behind
// the Pulumi URNs: renaming one destroys and recreates that resource on the next deploy,
// so treat this file as append-only unless a deliberate state migration is planned.
export const LOGICAL_NAMES = Object.freeze({
  lambdaRole: "LoopedInApiRole",
  lambdaRoleLogs: "LoopedInApiLogs",
  apiFunction: "LoopedInApi",
  httpApi: "LoopedInHttpApi",
  httpApiIntegration: "LoopedInHttpApiIntegration",
  httpApiDefaultRoute: "LoopedInHttpApiDefaultRoute",
  httpApiAccessLogs: "LoopedInHttpApiAccessLogs",
  httpApiStage: "LoopedInHttpApiStage",
  httpApiInvokePermission: "LoopedInHttpApiInvoke",
  web: "LoopedInWeb",
  budget: "LoopedInCostGuard",
});

// Stack outputs are a compatibility contract (DEPLOY.md documents them). Never rename an
// existing key.
export const OUTPUT_KEYS = Object.freeze(["web", "api"] as const);
export type OutputKey = (typeof OUTPUT_KEYS)[number];
