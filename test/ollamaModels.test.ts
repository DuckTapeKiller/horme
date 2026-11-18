import { test } from "node:test";
import assert from "node:assert";
import { isOllamaEmbeddingModel, pickOllamaChatModel } from "../src/utils/ollamaModels";

const tags = [
  { name: "nomic-embed-text:latest", modified_at: "2026-11-10T10:00:00Z", details: { family: "nomic-bert" } },
  { name: "qwen3.5:2b", modified_at: "2026-11-12T10:00:00Z", details: { family: "qwen35" } },
  { name: "bonsai-2:9b", modified_at: "2026-11-15T10:00:00Z", details: { family: "qwen35" } },
  { name: "llama3.1:8b", modified_at: "2026-10-01T10:00:00Z", details: { family: "llama" } },
];

void test("embedding models are told apart by name or family", () => {
  assert.strictEqual(isOllamaEmbeddingModel(tags[0]), true);
  assert.strictEqual(isOllamaEmbeddingModel({ name: "mxbai-embed-large" }), true);
  assert.strictEqual(isOllamaEmbeddingModel({ name: "all-minilm", details: { family: "bert" } }), true);
  assert.strictEqual(isOllamaEmbeddingModel(tags[1]), false);
});

void test("a missing model is replaced by one of the same family, else a common chat family", () => {
  assert.strictEqual(pickOllamaChatModel(tags, "qwen3.5:9b"), "qwen3.5:2b");
  assert.strictEqual(pickOllamaChatModel(tags, ""), "llama3.1:8b");
  assert.strictEqual(pickOllamaChatModel(tags.slice(0, 3), ""), "qwen3.5:2b");
});

void test("with no common family, the most recently changed chat model; never an embedding model", () => {
  assert.strictEqual(pickOllamaChatModel([tags[0], tags[2]], ""), "bonsai-2:9b");
  assert.strictEqual(pickOllamaChatModel([tags[0]], ""), null);
});
