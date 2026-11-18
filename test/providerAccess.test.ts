import { test } from "node:test";
import assert from "node:assert";
import {
  bearer,
  compatBaseUrl,
  customServerIsMine,
  embeddingSourceAllowed,
  isOllamaCloudModel,
  notesDestination,
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

const LAN = "http://192.168.1.20:4000/v1";
const mine = { customIsLocal: true, customUrl: LAN, customTrustedUrl: LAN };
const notMine = { customIsLocal: false, customUrl: LAN, customTrustedUrl: "" };

void test("keepsNotesPrivate: local servers always, cloud providers never", () => {
  for (const id of ["llamacpp", "ollama", "lmstudio"] as const) {
    assert.strictEqual(keepsNotesPrivate(notMine, id), true, id);
  }
  for (const id of ["claude", "gemini", "openai", "groq", "openrouter", "mistral"] as const) {
    assert.strictEqual(keepsNotesPrivate(mine, id), false, id);
  }
});

void test("keepsNotesPrivate: the OpenAI-compatible server counts as cloud until the user says it is theirs", () => {
  assert.strictEqual(keepsNotesPrivate(notMine, "custom"), false);
  assert.strictEqual(keepsNotesPrivate({} as typeof mine, "custom"), false);
  assert.strictEqual(keepsNotesPrivate(mine, "custom"), true);
});

void test("customServerIsMine: the mark belongs to the address it was given for", () => {
  // Same server, written differently: still the user's.
  assert.strictEqual(customServerIsMine({ ...mine, customUrl: `${LAN}/` }), true);
  assert.strictEqual(customServerIsMine({ ...mine, customUrl: `${LAN}/chat/completions` }), true);
  // Another address: a new server, cloud until confirmed again.
  assert.strictEqual(customServerIsMine({ ...mine, customUrl: "https://notes-collector.example/v1" }), false);
  assert.strictEqual(
    keepsNotesPrivate({ ...mine, customUrl: "https://api.deepseek.com/v1" }, "custom"),
    false,
  );
  // Never for an empty address, nor for a mark with no confirmed address.
  assert.strictEqual(customServerIsMine({ customIsLocal: true, customUrl: "", customTrustedUrl: "" }), false);
  assert.strictEqual(
    customServerIsMine({ customIsLocal: true, customUrl: LAN, customTrustedUrl: "" }),
    false,
  );
});

void test("isEmbeddingSource accepts the four servers only", () => {
  for (const v of ["llamacpp", "lmstudio", "ollama", "custom"])
    assert.strictEqual(isEmbeddingSource(v), true, v);
  for (const v of ["openai", "claude", "", undefined, null, 3])
    assert.strictEqual(isEmbeddingSource(v), false);
});

void test("embeddingSourceAllowed: local servers always; the OpenAI-compatible server only while it is yours", () => {
  for (const id of ["llamacpp", "lmstudio", "ollama"] as const) {
    assert.strictEqual(embeddingSourceAllowed({ embeddingSource: id, ...notMine }), true, id);
  }
  assert.strictEqual(embeddingSourceAllowed({ embeddingSource: "custom", ...notMine }), false);
  assert.strictEqual(embeddingSourceAllowed({ embeddingSource: "custom", ...mine }), true);
  // A changed address pauses it: nothing is sent to the new one.
  assert.strictEqual(
    embeddingSourceAllowed({ embeddingSource: "custom", ...mine, customUrl: "https://elsewhere.example/v1" }),
    false,
  );
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

void test("Ollama's cloud models are cloud, whatever runs on this computer", () => {
  for (const m of ["gpt-oss:120b-cloud", "deepseek-v3.1:671b-cloud", "glm-4.6:cloud", "KIMI-K2:1T-CLOUD"])
    assert.strictEqual(isOllamaCloudModel(m), true, m);
  for (const m of ["bonsai-2:9b", "qwen3.5:2b", "nomic-embed-text", "cloudy-model:7b", "", undefined])
    assert.strictEqual(isOllamaCloudModel(m), false, String(m));
  assert.strictEqual(keepsNotesPrivate({ ...notMine, defaultModel: "bonsai-2:9b" }, "ollama"), true);
  assert.strictEqual(keepsNotesPrivate({ ...notMine, defaultModel: "gpt-oss:120b-cloud" }, "ollama"), false);
  // Another model given (tags, tag translation) is judged instead of the chat's.
  assert.strictEqual(
    keepsNotesPrivate({ ...notMine, defaultModel: "bonsai-2:9b" }, "ollama", "glm-4.6:cloud"),
    false,
  );
});

void test("notesDestination: a new address or Ollama model is a new destination", () => {
  const s = { customUrl: "http://a.example/v1/", defaultModel: "qwen3.5:2b" };
  assert.strictEqual(notesDestination(s, "custom"), "custom@http://a.example/v1");
  assert.notStrictEqual(
    notesDestination(s, "custom"),
    notesDestination({ ...s, customUrl: "http://b.example/v1" }, "custom"),
  );
  assert.strictEqual(notesDestination(s, "ollama"), "ollama:qwen3.5:2b");
  assert.strictEqual(notesDestination(s, "gemini"), "gemini");
});
