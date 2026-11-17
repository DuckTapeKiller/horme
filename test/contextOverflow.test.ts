import { test } from "node:test";
import assert from "node:assert";
import { explainContextOverflow, ollamaNumCtx, wasCut } from "../src/utils/contextOverflow";

const ollama =
  "Ollama stream error: 400 — request (9462 tokens) exceeds the available context size (4096 tokens), try increasing it";

void test("a context-window refusal says what was needed, what there is, and where to raise it", () => {
  const out = explainContextOverflow(ollama, "ollama", "Ollama") ?? "";
  assert.match(out, /9,462 tokens/);
  assert.match(out, /4,096 tokens/);
  assert.match(out, /Context window on Ollama's page in Horme's Models settings/);
  assert.match(out, /Vault Brain/);
});

void test("each local server is told where its own window is set", () => {
  const llama = "Server error (400): request (20000 tokens) exceeds the available context size (8192 tokens)";
  assert.match(explainContextOverflow(llama, "llamacpp", "llama.cpp") ?? "", /--ctx-size/);
  assert.match(
    explainContextOverflow(llama, "lmstudio", "LM Studio") ?? "",
    /LM Studio with a larger context length/,
  );
  assert.match(
    explainContextOverflow(llama, "custom", "OpenAI-compatible server") ?? "",
    /larger context window on the server/,
  );
});

void test("any other error is left alone", () => {
  assert.strictEqual(explainContextOverflow("Ollama error: 401 — Invalid API key", "ollama", "Ollama"), null);
  assert.strictEqual(explainContextOverflow("net::ERR_CONNECTION_REFUSED", "llamacpp", "llama.cpp"), null);
  assert.strictEqual(explainContextOverflow("", "ollama", "Ollama"), null);
});

void test("wasCut: a request read as far fewer tokens than its length allows was cut", () => {
  // Ollama kept 2,050 tokens of a 63,000-character request (measured with qwen:latest, 4,096 window).
  assert.strictEqual(wasCut(63000, 2050), true);
  // A request just over a 4,096 window, cut to half of it.
  assert.strictEqual(wasCut(17000, 2050), true);
});

void test("wasCut: ordinary requests, short ones and missing counts are not flagged", () => {
  assert.strictEqual(wasCut(24797 + 50, 6800), false); // about four characters a token
  assert.strictEqual(wasCut(100, 30), false);
  assert.strictEqual(wasCut(3000, 2500), false); // CJK runs nearer one character a token
  assert.strictEqual(wasCut(63000, undefined), false);
  assert.strictEqual(wasCut(63000, 0), false);
  assert.strictEqual(wasCut(63000, "2050"), false);
});

void test("ollamaNumCtx: the setting, capped at the model's own length", () => {
  assert.strictEqual(ollamaNumCtx(16384, 262144), 16384); // bonsai-2
  assert.strictEqual(ollamaNumCtx(65536, 32768), 32768); // qwen:latest is built for 32,768
  assert.strictEqual(ollamaNumCtx(16384, null), 16384); // Ollama would not say: send the setting
  assert.strictEqual(ollamaNumCtx(16384.7, 0), 16384);
});

void test("ollamaNumCtx: 0 (or nonsense) leaves the window to Ollama", () => {
  assert.strictEqual(ollamaNumCtx(0, 262144), null);
  assert.strictEqual(ollamaNumCtx(-5, 262144), null);
  assert.strictEqual(ollamaNumCtx(Number.NaN, 262144), null);
});
