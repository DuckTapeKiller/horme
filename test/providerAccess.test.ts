import { test } from "node:test";
import assert from "node:assert";
import {
  bearer,
  compatBaseUrl,
  embeddingSourceAllowed,
  initialEmbeddingSource,
  isEmbeddingSource,
  isLocalServer,
  keepsNotesPrivate,
} from "../src/utils/providerAccess";

void test("bearer: no key sends no header at all", () => {
  assert.deepStrictEqual(bearer(""), {});
  assert.deepStrictEqual(bearer("   "), {});
  assert.deepStrictEqual(bearer(undefined), {});
  assert.deepStrictEqual(bearer(null), {});
});

void test("bearer: a key becomes a trimmed Bearer header", () => {
  assert.deepStrictEqual(bearer(" sk-local-123 \n"), { Authorization: "Bearer sk-local-123" });
});

void test("compatBaseUrl keeps the version path the server's docs give", () => {
  assert.strictEqual(compatBaseUrl("http://localhost:4000/v1"), "http://localhost:4000/v1");
  assert.strictEqual(compatBaseUrl("https://api.deepseek.com/v1/"), "https://api.deepseek.com/v1");
  assert.strictEqual(compatBaseUrl("http://openwebui.lan:3000/api"), "http://openwebui.lan:3000/api");
  assert.strictEqual(
    compatBaseUrl("https://generativelanguage.googleapis.com/v1beta/openai/"),
    "https://generativelanguage.googleapis.com/v1beta/openai",
  );
});

void test("compatBaseUrl cuts a pasted endpoint back to its base", () => {
  assert.strictEqual(
    compatBaseUrl("  http://localhost:8000/v1/chat/completions "),
    "http://localhost:8000/v1",
  );
  assert.strictEqual(compatBaseUrl("http://localhost:8000/v1/models/"), "http://localhost:8000/v1");
  assert.strictEqual(compatBaseUrl("http://localhost:8000/v1/completions"), "http://localhost:8000/v1");
});

void test("compatBaseUrl leaves an empty address empty", () => {
  assert.strictEqual(compatBaseUrl("   "), "");
});

void test("isLocalServer knows the three local servers only", () => {
  for (const id of ["llamacpp", "ollama", "lmstudio"]) assert.strictEqual(isLocalServer(id), true, id);
  for (const id of ["custom", "openai", "claude", ""]) assert.strictEqual(isLocalServer(id), false, id);
});

void test("keepsNotesPrivate: local servers always, cloud providers never", () => {
  const trusting = { customIsLocal: true };
  const wary = { customIsLocal: false };
  for (const id of ["llamacpp", "ollama", "lmstudio"] as const) {
    assert.strictEqual(keepsNotesPrivate(wary, id), true, id);
  }
  for (const id of ["claude", "gemini", "openai", "groq", "openrouter", "mistral"] as const) {
    assert.strictEqual(keepsNotesPrivate(trusting, id), false, id);
  }
});

void test("keepsNotesPrivate: the OpenAI-compatible server counts as cloud until the user says it is theirs", () => {
  assert.strictEqual(keepsNotesPrivate({ customIsLocal: false }, "custom"), false);
  assert.strictEqual(keepsNotesPrivate({} as { customIsLocal: boolean }, "custom"), false);
  assert.strictEqual(keepsNotesPrivate({ customIsLocal: true }, "custom"), true);
});

void test("isEmbeddingSource accepts the four servers only", () => {
  for (const v of ["llamacpp", "lmstudio", "ollama", "custom"])
    assert.strictEqual(isEmbeddingSource(v), true, v);
  for (const v of ["openai", "claude", "", undefined, null, 3])
    assert.strictEqual(isEmbeddingSource(v), false);
});

void test("embeddingSourceAllowed: local servers always; the OpenAI-compatible server only while it is yours", () => {
  for (const id of ["llamacpp", "lmstudio", "ollama"] as const) {
    assert.strictEqual(embeddingSourceAllowed({ embeddingSource: id, customIsLocal: false }), true, id);
  }
  assert.strictEqual(embeddingSourceAllowed({ embeddingSource: "custom", customIsLocal: false }), false);
  assert.strictEqual(embeddingSourceAllowed({ embeddingSource: "custom", customIsLocal: true }), true);
});

void test("initialEmbeddingSource keeps the server an existing index was built with", () => {
  // Embeddings followed a local chat provider...
  assert.strictEqual(initialEmbeddingSource({ aiProvider: "llamacpp" }, "llamacpp"), "llamacpp");
  assert.strictEqual(initialEmbeddingSource({ aiProvider: "lmstudio" }, "llamacpp"), "lmstudio");
  assert.strictEqual(initialEmbeddingSource({ aiProvider: "ollama" }, "llamacpp"), "ollama");
  // ...and came from Ollama for every other one.
  for (const p of ["claude", "gemini", "openai", "groq", "openrouter", "mistral", "custom"]) {
    assert.strictEqual(initialEmbeddingSource({ aiProvider: p }, "llamacpp"), "ollama", p);
  }
});

void test("initialEmbeddingSource leaves a saved choice and a new install alone", () => {
  assert.strictEqual(
    initialEmbeddingSource({ aiProvider: "gemini", embeddingSource: "llamacpp" }, "llamacpp"),
    null,
  );
  assert.strictEqual(
    initialEmbeddingSource({ aiProvider: "llamacpp", embeddingSource: "custom" }, "llamacpp"),
    null,
  );
  assert.strictEqual(initialEmbeddingSource({}, "llamacpp"), null);
});

void test("initialEmbeddingSource repairs an unreadable choice, and uses the default chat provider when none is saved", () => {
  assert.strictEqual(
    initialEmbeddingSource({ aiProvider: "llamacpp", embeddingSource: "nonsense" }, "llamacpp"),
    "llamacpp",
  );
  assert.strictEqual(initialEmbeddingSource({ temperature: 0.5 }, "llamacpp"), "llamacpp");
  assert.strictEqual(initialEmbeddingSource({ temperature: 0.5 }, "ollama"), "ollama");
});
