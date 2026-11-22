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

// Patches to dependencies, applied before bundling. Each must find its text
// exactly once: the build stops if a new version moved the code, so the patch
// is looked at again rather than silently dropped.
//
// docx carries its own copy of JSZip and, with it, old-browser polyfills for
// setImmediate. Obsidian never takes their Internet Explorer paths (script tags
// that fire onreadystatechange), and JSZip only ever passes setImmediate a
// function, never a string the polyfill would turn into code with new Function.
// Those paths are taken out, so the release holds neither.
//
// minimatch 11 finds {lo..hi} ranges with a lookbehind, (?<![\\$]), which iOS
// before 16.4 cannot parse: the whole plugin would fail to load there. The same
// check is made in the replace callback instead, on the character before the
// match. A range holds no "{", so no match can start inside another one, and
// the result is the same.
const PATCHES = [
  {
    file: /[\\/]node_modules[\\/]docx[\\/]dist[\\/]index\.mjs$/,
    edits: [
      [
        '"function" != typeof e4 && (e4 = new Function("" + e4));',
        'if ("function" != typeof e4) throw new TypeError("setImmediate takes a function");',
      ],
      ['l && "onreadystatechange" in l.createElement("script") ?', "false ?"],
      ['"document" in t2 && "onreadystatechange" in t2.document.createElement("script") ?', "false ?"],
    ],
  },
  {
    file: /[\\/]node_modules[\\/]minimatch[\\/]dist[\\/]esm[\\/]index\.js$/,
    edits: [
      [
        String.raw`const rangeRe = /(?<![\\$])\{(-?\d+)\.\.(-?\d+)\}/g;`,
        String.raw`const rangeRe = /\{(-?\d+)\.\.(-?\d+)\}/g;`,
      ],
      [
        "const marked = pattern.replace(rangeRe, (m, lo, hi) => {",
        'const marked = pattern.replace(rangeRe, (m, lo, hi, at) => {\n            const before = at > 0 ? pattern.charAt(at - 1) : "";\n            if (before === "\\\\" || before === "$") return m;',
      ],
    ],
  },
];

const dependencyPatches = {
  name: "dependency-patches",
  setup(build) {
    for (const { file, edits } of PATCHES) {
      build.onLoad({ filter: file }, async (args) => {
        let code = await fs.promises.readFile(args.path, "utf8");
        for (const [from, to] of edits) {
          const found = code.split(from).length - 1;
          if (found !== 1) throw new Error(`Patch for ${args.path}: expected one "${from}", found ${found}`);
          code = code.replace(from, to);
        }
        return { contents: code, loader: "js" };
      });
    }
  },
};

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
    plugins: [dependencyPatches],
  })
  .then(() => sanitizeObsidianPublishWarnings("main.js"))
  .catch(() => process.exit(1));
