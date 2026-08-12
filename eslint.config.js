import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
// Local plugin, no package needed: flat config takes a plugin OBJECT, so an
// ESM default export from the repo is registered exactly like an npm one.
import sentinel from "./eslint-rules/no-fabricated-fallback.js";

export default tseslint.config(
  { ignores: ["dist", ".output", ".vinxi"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "server-only",
              message:
                "TanStack Start does not use the Next.js `server-only` package. Rename the module to `*.server.ts` or mark it with `@tanstack/react-start/server-only`.",
            },
          ],
        },
      ],
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  /*
   * Fabrication guards — CLAUDE.md "Never fabricate data".
   *
   * Scoped to the collectors (src/utils) and the pages that render what they
   * return (src/routes). Deliberately NOT applied to src/components/ui — that
   * is vendored shadcn, where `value || 0` is a progress bar, not a
   * measurement, and it produced the only out-of-scope false positive when
   * this was measured.
   *
   * Measured over the tree on 2026-08-12: 32 findings, 21 true positives.
   * The 11 known false positives each need ONE justified disable, e.g.
   *
   *   // eslint-disable-next-line sentinel/no-fabricated-fallback -- UCDP
   *   // supplies these three fields together or not at all; the .some()
   *   // guard above proves at least one was reported, so the zeros are
   *   // measured, not assumed.
   *
   * require-fabrication-justification rejects a bare disable with no `--`
   * reason, so silencing this rule always leaves a written argument behind.
   */
  {
    name: "sentinel/fabrication-guards",
    files: ["src/routes/**/*.{ts,tsx}", "src/utils/**/*.{ts,tsx}"],
    plugins: { sentinel },
    rules: {
      "sentinel/no-fabricated-fallback": "error",
      "sentinel/require-fabrication-justification": "error",
    },
  },
  eslintPluginPrettier,
);
