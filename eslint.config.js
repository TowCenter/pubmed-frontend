import js from "@eslint/js";
import svelte from "eslint-plugin-svelte";
import globals from "globals";

export default [
  js.configs.recommended,
  ...svelte.configs["flat/recommended"],
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // The codebase leans on unused destructured params / intentional no-ops
      // in a few places (event handlers, placeholder branches) — warn instead
      // of hard-erroring so lint stays useful without blocking on style calls.
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  {
    ignores: ["dist/**", "node_modules/**", "public/**", "entity_dedup_experiments/**"],
  },
];
