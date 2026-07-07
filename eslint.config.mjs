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
      // Sentence-case for UI text, enforced at error level so the build fails
      // exactly where the Obsidian review would flag it. Brand names and
      // acronyms used across the UI are declared so they keep their casing.
      "obsidianmd/ui/sentence-case": [
        "error",
        {
          brands: [
            "Horme",
            "Obsidian",
            "Ollama",
            "LM Studio",
            "Wikipedia",
            "Wiktionary",
            "DuckDuckGo",
            "Claude",
            "Anthropic",
            "Gemini",
            "Google",
            "OpenAI",
            "GPT",
            "Groq",
            "OpenRouter",
            "Mistral",
            "Markdown",
            "YAML",
            "Text Extractor",
            // Feature names and languages that keep their capitalization.
            "Vault Brain",
            "Grammar Scholar",
            "Spanish",
            "English",
          ],
          acronyms: [
            "AI",
            "API",
            "URL",
            "RAG",
            "RRF",
            "ID",
            "JSON",
            "PDF",
            "HTTP",
            "XML",
            "CORS",
            "LLM",
            "DOCX",
            "RAE",
            "POST",
            "GET",
          ],
          // Strings opening with a decorative glyph ("◈ Section", "+ Add …")
          // capitalize their first word by design; the rule would treat the
          // glyph as the sentence start and lowercase the word after it.
          ignoreRegex: ["^◈", "^\\+", "^●", "\\[\\d+\\]"],
          allowAutoFix: true,
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },

  // Keep ESLint out of Prettier's formatting domain.
  eslintConfigPrettier,
]);
