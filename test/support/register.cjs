// Resolves "obsidian" to the test stand-in, so modules that import it can be unit-tested.
const Module = require("node:module");
const path = require("node:path");
const stub = path.join(__dirname, "obsidian.ts");
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return resolve.call(this, request === "obsidian" ? stub : request, ...rest);
};
