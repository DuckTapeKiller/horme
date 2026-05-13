import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "node:module";

import fs from "fs";

const prod = process.argv[2] === "production";

/* Read the PDF worker code so we can inline it for 100% offline support */
const workerPath = "node_modules/pdfjs-dist/legacy/build/pdf.worker.min.js";
const workerCode = fs.readFileSync(workerPath, "utf8");

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
    treeShaking: true,
    outfile: "main.js",
    define: {
      "__PDF_WORKER_CODE__": JSON.stringify(workerCode),
    },
  })
  .catch(() => process.exit(1));
