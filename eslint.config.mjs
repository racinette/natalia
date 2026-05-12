// @ts-check
import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Turn off the base rule; use the TS version only
      "no-unused-vars": "off",
      "@typescript-eslint/no-unnecessary-type-parameters": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      // Spec / scratch TS under refactor — not part of main tsconfig project
      "refactor/**",
      // Vendored Standard Schema spec — must match upstream verbatim
      "src/types/standard-schema.ts",
    ],
  },
  {
    files: ["src/types-regression-tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-type-assertion": "error",
      // `IsEqual` helpers intentionally use a dummy type parameter (see `13_workflow_interface.ts`).
      "@typescript-eslint/no-unnecessary-type-parameters": "off",
    },
  },
);