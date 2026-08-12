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
   * Measured over the tree on 2026-08-12: 32 findings, of which roughly a third
   * were genuine fabrications (now fixed) and the rest are honest type labels,
   * provenance strings and UI placeholder states.
   *
   * THE DISABLE MUST BE ONE LINE. An adversarial check of the original
   * documentation found the multi-line form it recommended produces THREE
   * errors rather than zero:
   *
   *   - `eslint-disable-next-line` targets the line immediately after the
   *     comment. If that line is another comment, the rule still fires on the
   *     code below it.
   *   - ESLint then reports the directive itself as unused.
   *   - The justification on the directive line was shorter than the 20
   *     characters `require-fabrication-justification` demands, so that rule
   *     fired too.
   *
   * Correct form — one line, whole reason after `--`, at least 20 characters:
   *
   *   // eslint-disable-next-line sentinel/no-fabricated-fallback -- guard above proves at least one field was reported, so these zeros are measured
   *
   * require-fabrication-justification rejects a bare disable with no `--`
   * reason, so silencing this rule always leaves a written argument behind.
   *
   * SEVERITY. "warn", not "error", and deliberately. The rule's heuristic
   * cannot separate a fabricated measurement from an honest label without
   * reading intent — `title: x ?? "Seismic event"` and `status: x || "online"`
   * are the same shape and only one is a lie. Landing it at "error" would push
   * a maintainer toward silencing it, and a guard everyone disables catches
   * nothing. As a warning it is a review prompt: every hit needs a human
   * decision, and the ones that are real are fixed rather than annotated.
   */
  {
    name: "sentinel/fabrication-guards",
    files: ["src/routes/**/*.{ts,tsx}", "src/utils/**/*.{ts,tsx}"],
    plugins: { sentinel },
    rules: {
      "sentinel/no-fabricated-fallback": "warn",
      // This one IS an error: it only fires on a disable comment that someone
      // deliberately wrote, and a silenced fabrication guard with no stated
      // reason is exactly what this whole mechanism exists to prevent.
      "sentinel/require-fabrication-justification": "error",
    },
  },
  eslintPluginPrettier,
);
