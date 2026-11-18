import { test } from "node:test";
import assert from "node:assert";
import { parseEmbeddingLabel, sameEmbeddingSpace } from "../src/utils/embeddingLabel";

const LLAMA = "llamacpp:text-embedding-nomic-embed-text-v2-moe";

void test("labels name the server kind, the model and, for the compatible server, the address", () => {
  assert.deepStrictEqual(parseEmbeddingLabel("ollama:nomic-embed-text:latest"), {
    kind: "ollama",
    model: "nomic-embed-text:latest",
    address: "",
  });
  assert.deepStrictEqual(parseEmbeddingLabel("custom:nomic-embed-text:latest@http://127.0.0.1:11434/v1"), {
    kind: "custom",
    model: "nomic-embed-text:latest",
    address: "http://127.0.0.1:11434/v1",
  });
  assert.strictEqual(parseEmbeddingLabel("nomic-embed-text"), null);
});

void test("the same set-up matches; another model or server kind does not", () => {
  assert.strictEqual(sameEmbeddingSpace(LLAMA, LLAMA), true);
  assert.strictEqual(sameEmbeddingSpace("", LLAMA), true);
  assert.strictEqual(sameEmbeddingSpace(LLAMA, "llamacpp:bge-m3"), false);
  assert.strictEqual(sameEmbeddingSpace(LLAMA, "lmstudio:text-embedding-nomic-embed-text-v2-moe"), false);
  assert.strictEqual(sameEmbeddingSpace("ollama:nomic-embed-text", "ollama:mxbai-embed-large"), false);
});

void test("the compatible server: a new address is a new space, even with the same model name", () => {
  assert.strictEqual(
    sameEmbeddingSpace("custom:nomic@http://127.0.0.1:8131/v1", "custom:nomic@http://127.0.0.1:11434/v1"),
    false,
  );
  assert.strictEqual(
    sameEmbeddingSpace("custom:nomic@http://127.0.0.1:8131/v1", "custom:nomic@http://127.0.0.1:8131/v1"),
    true,
  );
});

void test("an index labelled before models were recorded (auto) is taken as the model there now", () => {
  assert.strictEqual(sameEmbeddingSpace("llamacpp:auto", LLAMA), true);
  assert.strictEqual(sameEmbeddingSpace("custom:auto", "custom:nomic@http://127.0.0.1:8131/v1"), true);
  // Not across server kinds.
  assert.strictEqual(sameEmbeddingSpace("llamacpp:auto", "lmstudio:nomic"), false);
});
