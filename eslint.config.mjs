import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import eslintConfigPrettier from "eslint-config-prettier";

// Flat config (ESLint 9+). Runs the official Obsidian community-plugin review
// (eslint-plugin-obsidianmd) plus type-aware typescript-eslint rules so plugin
// compliance can be verified locally and in CI instead of via the online review.
export default defineConfig([
  // Lint the shipped plugin source only: main.ts + src/**. Exclude the build
  // artifact, tooling, tests, and all JSON (the recommended config's JSON handling
  // misparses arbitrary JSON; manifest is validated by the store separately).
  {
    ignores: ["node_modules/", "main.js", "eslint.config.mjs", "esbuild.config.mjs", "test/", "**/*.json"],
  },

  ...obsidianmd.configs.recommended,

  {
    files: ["**/*.ts"],
    languageOptions: {
      // Enable type-aware linting for the plugin's TypeScript sources.
      parserOptions: { project: "./tsconfig.json" },
    },
    rules: {
      // Intentional `while (true)` loops drive the skill/tool iteration queues.
      "no-constant-condition": "off",
      // TypeScript already reports undefined identifiers and knows the Electron
      // runtime globals (Buffer, process); eslint's no-undef is redundant here.
      "no-undef": "off",
      // Streaming chat requires `fetch` — Obsidian's `requestUrl` cannot stream
      // responses. Kept intentionally (see provider stream() methods).
      "no-restricted-globals": "off",
      // Sentence-case for UI text is an Obsidian style guideline, not a blocker;
      // surface it as advisory rather than failing the build.
      "obsidianmd/ui/sentence-case": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },

  // Keep ESLint out of Prettier's formatting domain.
  eslintConfigPrettier,
]);
