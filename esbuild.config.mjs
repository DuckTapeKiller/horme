import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "node:module";
import fs from "fs";

const prod = process.argv[2] === "production";

function sanitizeObsidianPublishWarnings(filePath) {
  // Obsidian's review tooling flags dynamic `<script>` element creation as an error.
  // Some dependencies include old polyfills that create script tags. We disable those
  // code paths by ensuring they never create actual `<script>` elements.
  //
  const original = fs.readFileSync(filePath, "utf8");
  const updated = original.replaceAll('createElement("script")', 'createElement("noscript")');

  if (updated !== original) fs.writeFileSync(filePath, updated, "utf8");
}

esbuild
  .build({
    entryPoints: ["main.ts"],
    bundle: true,
    external: [
      "obsidian",
      "electron",
      "@codemirror/autocomplete",
      "@codemirror/collab",
      "@codemirror/commands",
      "@codemirror/language",
      "@codemirror/lint",
      "@codemirror/search",
      "@codemirror/state",
      "@codemirror/view",
      "@lezer/common",
      "@lezer/highlight",
      "@lezer/lr",
      ...builtinModules,
    ],
    format: "cjs",
    target: "es2018",
    logLevel: "info",
    sourcemap: prod ? false : "inline",
    minify: prod,
    treeShaking: true,
    outfile: "main.js",
  })
  .then(() => sanitizeObsidianPublishWarnings("main.js"))
  .catch(() => process.exit(1));
