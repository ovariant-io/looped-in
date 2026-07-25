/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  async app(input) {
    // SST owns provider imports; local modules are loaded dynamically (top-level imports
    // aren't allowed in sst.config.ts) so this file stays the only entry point while
    // resource policy lives organized by domain under infra/.
    const { createAppConfig } = await import("./infra/app");
    return createAppConfig(input?.stage);
  },

  async run() {
    const { composeInfrastructure } = await import("./infra/index");
    return composeInfrastructure({
      repoRoot: $cli.paths.root,
      stage: $app.stage,
    });
  },
});
