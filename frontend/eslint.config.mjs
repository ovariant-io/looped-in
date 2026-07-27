import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // OpenNext's build output. Not in the default list, and it is bundled third-party code —
    // left in, `npm run lint` reports thousands of problems from it and a real error in app/
    // is buried, which makes the lint gate useless on any machine that has run a build.
    ".open-next/**",
  ]),
]);

export default eslintConfig;
