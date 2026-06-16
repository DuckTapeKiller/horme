import { test } from "node:test";
import assert from "node:assert/strict";
import {
  quantizeEmbeddingToInt8,
  compressEmbedding,
  decompressEmbeddingToInt8,
  decompressEmbedding,
  cosineSimilarity,
  cosineSimilarityInt8,
  cosineSimilarityFloatInt8,
  getModelPrefixes,
} from "../src/utils/VectorUtils";

test("quantizeEmbeddingToInt8 maps [-1,1] -> [-127,127] and clamps out-of-range", () => {
  assert.deepEqual(Array.from(quantizeEmbeddingToInt8([0, 1, -1])), [0, 127, -127]);
  assert.deepEqual(Array.from(quantizeEmbeddingToInt8([2, -2])), [127, -127]);
  assert.equal(quantizeEmbeddingToInt8([0.5])[0], 64); // round(63.5)
});

test("compress -> decompress round-trips int8 bytes exactly", () => {
  const q = quantizeEmbeddingToInt8([0, 1, -1, 0.25, -0.5, 0.999]);
  const back = decompressEmbeddingToInt8(compressEmbedding(q));
  assert.deepEqual(Array.from(back), Array.from(q));
});

test("decompressEmbedding restores normalized floats", () => {
  const floats = decompressEmbedding(compressEmbedding(quantizeEmbeddingToInt8([0, 1, -1])));
  assert.deepEqual(floats, [0, 1, -1]);
});

test("cosineSimilarity: identical=1, orthogonal=0, opposite=-1, zero/empty=0", () => {
  assert.ok(Math.abs(cosineSimilarity([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [-1, 0]) + 1) < 1e-9);
  assert.equal(cosineSimilarity([0, 0], [1, 2]), 0);
  assert.equal(cosineSimilarity([], []), 0);
});

test("cosineSimilarity uses the shorter length on mismatch", () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0, 999], [1, 0]) - 1) < 1e-9);
});

test("int8 cosine variants approximate the float cosine (scale cancels)", () => {
  const a = [0.1, 0.2, 0.9, -0.4];
  const b = [0.2, 0.1, 0.8, -0.3];
  const qa = quantizeEmbeddingToInt8(a);
  const qb = quantizeEmbeddingToInt8(b);
  const floatCos = cosineSimilarity(a, b);
  assert.ok(Math.abs(cosineSimilarityInt8(qa, qb) - floatCos) < 0.03);
  assert.ok(Math.abs(cosineSimilarityFloatInt8(a, qb) - floatCos) < 0.03);
  assert.ok(Math.abs(cosineSimilarityInt8(qa, qa) - 1) < 1e-9);
});

test("getModelPrefixes selects by model family", () => {
  assert.deepEqual(getModelPrefixes("nomic-embed-text"), {
    query: "search_query: ",
    doc: "search_document: ",
  });
  assert.ok(getModelPrefixes("mxbai-embed-large").query.length > 0);
  assert.deepEqual(getModelPrefixes("bge-m3"), { query: "", doc: "" });
});
