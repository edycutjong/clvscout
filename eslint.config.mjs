// Flat ESLint config — Node 20 + TypeScript service.
// Base = @eslint/js recommended + typescript-eslint recommended.
// Rules kept pragmatic so `eslint .` runs clean on the existing code
// without a mass rewrite; typecheck (`tsc --noEmit`) stays the strict gate.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    // Generated output, deps, and the README asset toolchain are not linted.
    ignores: [
      "node_modules/**",
      "dist/**",
      "coverage/**",
      "docs/assets/**",
      "fixtures/**",
      "web/**",
      "**/*.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Wire shapes and rail payloads are intentionally loosely typed at the
      // boundary; `any` there is a deliberate design choice, not a smell.
      "@typescript-eslint/no-explicit-any": "off",
      // Surface unused code as a warning (not a hard error), and allow the
      // conventional `_`-prefix escape hatch for intentionally-unused args.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
);
