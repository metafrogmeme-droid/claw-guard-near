// ESLint flat config: type-aware typescript-eslint rules for the sources and tests.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/", "dist/", "coverage/", ".sandbox/"] },
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // A dropped promise in a CLI means a silently skipped step: never allow it.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      eqeqeq: ["error", "always"],
    },
  },
  {
    // Plain JS/MJS helpers (dev scripts, this file): JS rules with the Node globals they use.
    files: ["**/*.js", "**/*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: {
      sourceType: "module",
      globals: { process: "readonly", console: "readonly", URL: "readonly" },
    },
  },
);
