// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // .claude holds agent worktrees carrying full repo copies — linting them
    // double-reports everything and misses the preview-globals file scoping.
    ignores: ["dist/**", "node_modules/**", ".claude/**"],
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // The preview is plain browser JS, no build step — it runs in the
    // browser, not Node, so it needs browser globals instead.
    files: ["src/preview/**/*.js"],
    languageOptions: {
      globals: globals.browser,
    },
  },
);
