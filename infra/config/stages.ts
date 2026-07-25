// Where AWS Budgets cost alerts are emailed. Set LOOPED_IN_ALERT_EMAIL to override without
// editing this file — which is what a fork or a second operator should do, since the fallback
// below is one person's personal address and a deploy that silently keeps it sends THEM the
// cost alarms for YOUR account.
export const ALERT_EMAIL =
  process.env.LOOPED_IN_ALERT_EMAIL?.trim() || "prabath.udakandage@gmail.com";
// Monthly spend ceiling for the alarm (USD). Cheap by design — this stack scales to
// zero, so anything climbing toward this number means something is misconfigured.
export const MONTHLY_BUDGET_USD = "10";
// Canonical AWS region for every stage (Sydney). Keep this stage-independent so local,
// test, and prod deployments all land in the same region.
export const AWS_REGION = "ap-southeast-2";

// ---- Per-stage non-secret config -----------------------------------------------------
// CORS is owned by the API Gateway edge, not the .NET app (the app registers no CORS
// middleware, so there is no duplicate-header risk — see services/gateway.ts). Nothing
// calls the API from the browser today (`/me` is a server-side call), so the wildcard on
// local/test is unused in practice; prod must name exact origins and is blocked by
// assertStageDeployable() until it does.
export interface StageConfig {
  // Exact browser origins allowed by the gateway's CORS config, or ["*"] (non-prod only).
  readonly corsAllowOrigins: readonly string[];
  readonly accessLogRetentionDays: number;
}

export const STAGE_CONFIG: Record<string, StageConfig> = {
  local: { corsAllowOrigins: ["*"], accessLogRetentionDays: 30 },
  test: { corsAllowOrigins: ["*"], accessLogRetentionDays: 30 },
  prod: { corsAllowOrigins: [], accessLogRetentionDays: 90 },
};

export interface StageSettings extends StageConfig {
  readonly stage: string;
  readonly monthlyBudgetUsd: string;
  readonly alertEmail: string;
}

// Ad-hoc personal stages act like local. Deliberately NOT restricted to a stage allowlist —
// `sst deploy --stage <anything>` is a valid personal sandbox.
export function resolveStageSettings(stage: string): StageSettings {
  const config = STAGE_CONFIG[stage] ?? STAGE_CONFIG.local;
  return Object.freeze({
    stage,
    ...config,
    monthlyBudgetUsd: MONTHLY_BUDGET_USD,
    alertEmail: ALERT_EMAIL,
  });
}

// App-level policy consumed by sst.config.ts `app()`: tear everything down on non-prod
// stages; keep prod resources on `sst remove`.
export function resolveStagePolicy(stage: string | undefined) {
  const isProd = stage === "prod";
  return Object.freeze({
    removal: isProd ? ("retain" as const) : ("remove" as const),
    protect: isProd,
    region: AWS_REGION,
  });
}

// prod fails fast rather than launching with wildcard CORS. This guard unblocks itself:
// fill in STAGE_CONFIG.prod.corsAllowOrigins with the real web origin(s) and prod deploys.
export function assertStageDeployable(settings: StageSettings): void {
  if (settings.stage !== "prod") return;

  const origins = settings.corsAllowOrigins;
  if (origins.length === 0 || origins.includes("*")) {
    throw new Error(
      'prod deploys are blocked while STAGE_CONFIG.prod.corsAllowOrigins is empty or "*" ' +
        "(infra/config/stages.ts). Set the exact browser origin(s) allowed to call the API " +
        "— prod must never be born with wildcard CORS.",
    );
  }
}
