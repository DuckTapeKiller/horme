import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

// Flat config (ESLint 9+). Obsidian's official plugin lint, as the community-plugin
// review bot runs it: `obsidianmd.configs.recommended` with its own file globs (every
// TS and JS file, package.json, manifest.json and the licence) and full type
// information. Only the build output and the dependencies are left out, and no rule
// is switched off.
export default defineConfig([
  {
    ignores: ["node_modules/", "main.js"],
  },

  ...obsidianmd.configs.recommended,

  {
    // The type-aware rules need the TypeScript program.
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
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
            "Wikimedia",
            "Wikimedia Commons",
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
            // The Support section names the author and the donation site.
            "DuckTapeKiller",
            "Ko-fi",
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
    },
  },

  {
    // The build and lint configs are plain ESM outside the TS program, so the
    // type-aware rules cannot run on them.
    files: ["**/*.{js,cjs,mjs}"],
    ...tseslint.configs.disableTypeChecked,
  },
]);
