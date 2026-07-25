import { resolveStagePolicy } from "./config/stages";

export const APP_NAME = "looped-in";

// Consumed by sst.config.ts `app()`. Stage names match the env files: local | test | prod
// (see scripts/deploy.mjs); ad-hoc personal stages are allowed and act like local.
export function createAppConfig(stage: string | undefined) {
  const policy = resolveStagePolicy(stage);
  return {
    name: APP_NAME,
    removal: policy.removal,
    protect: policy.protect,
    home: "aws" as const,
    providers: {
      aws: { region: policy.region },
    },
  };
}
