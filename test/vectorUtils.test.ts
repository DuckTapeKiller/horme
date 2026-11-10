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

void test("quantizeEmbeddingToInt8 scales each vector to its largest component", () => {
  assert.deepEqual(Array.from(quantizeEmbeddingToInt8([0, 1, -1])), [0, 127, -127]);
  assert.deepEqual(Array.from(quantizeEmbeddingToInt8([2, -2])), [127, -127]);
  assert.deepEqual(Array.from(quantizeEmbeddingToInt8([0.04, -0.01])), [127, -32]);
  assert.deepEqual(Array.from(quantizeEmbeddingToInt8([0, 0])), [0, 0]);
  assert.deepEqual(Array.from(quantizeEmbeddingToInt8([NaN, 0.5])), [0, 127]);
});

void test("small normalised components keep their precision", () => {
  const dims = 768;
  const v = Array.from({ length: dims }, (_, i) => Math.sin(i * 1.7) / Math.sqrt(dims / 2));
  const w = v.map((x, i) => x + Math.cos(i * 0.9) * 0.01);
  const err = Math.abs(cosineSimilarityFloatInt8(v, quantizeEmbeddingToInt8(w)) - cosineSimilarity(v, w));
  assert.ok(err < 0.002, `error ${err}`);
});

void test("compress -> decompress round-trips int8 bytes exactly", () => {
  const q = quantizeEmbeddingToInt8([0, 1, -1, 0.25, -0.5, 0.999]);
  const back = decompressEmbeddingToInt8(compressEmbedding(q));
  assert.deepEqual(Array.from(back), Array.from(q));
});

void test("decompressEmbedding restores normalized floats", () => {
  const floats = decompressEmbedding(compressEmbedding(quantizeEmbeddingToInt8([0, 1, -1])));
  assert.deepEqual(floats, [0, 1, -1]);
});

void test("cosineSimilarity: identical=1, orthogonal=0, opposite=-1, zero/empty=0", () => {
  assert.ok(Math.abs(cosineSimilarity([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [-1, 0]) + 1) < 1e-9);
  assert.equal(cosineSimilarity([0, 0], [1, 2]), 0);
  assert.equal(cosineSimilarity([], []), 0);
});

void test("cosineSimilarity uses the shorter length on mismatch", () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0, 999], [1, 0]) - 1) < 1e-9);
});

void test("int8 cosine variants approximate the float cosine (scale cancels)", () => {
  const a = [0.1, 0.2, 0.9, -0.4];
  const b = [0.2, 0.1, 0.8, -0.3];
  const qa = quantizeEmbeddingToInt8(a);
  const qb = quantizeEmbeddingToInt8(b);
  const floatCos = cosineSimilarity(a, b);
  assert.ok(Math.abs(cosineSimilarityInt8(qa, qb) - floatCos) < 0.03);
  assert.ok(Math.abs(cosineSimilarityFloatInt8(a, qb) - floatCos) < 0.03);
  assert.ok(Math.abs(cosineSimilarityInt8(qa, qa) - 1) < 1e-9);
});

void test("getModelPrefixes selects by model family", () => {
  assert.deepEqual(getModelPrefixes("nomic-embed-text"), {
    query: "search_query: ",
    doc: "search_document: ",
  });
  assert.ok(getModelPrefixes("mxbai-embed-large").query.length > 0);
  assert.deepEqual(getModelPrefixes("bge-m3"), { query: "", doc: "" });
});
