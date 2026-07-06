import { test } from "node:test";
import assert from "node:assert";
import { normalizeBaseUrl } from "../src/utils/normalizeBaseUrl";

test("keeps a plain base URL untouched", () => {
  assert.strictEqual(normalizeBaseUrl("http://localhost:1234"), "http://localhost:1234");
});

test("strips a trailing slash", () => {
  assert.strictEqual(normalizeBaseUrl("http://localhost:1234/"), "http://localhost:1234");
});

test("strips a trailing /v1 (the double-/v1 bug)", () => {
  assert.strictEqual(normalizeBaseUrl("http://127.0.0.1:1234/v1"), "http://127.0.0.1:1234");
});

test("strips /v1 with a trailing slash", () => {
  assert.strictEqual(normalizeBaseUrl("http://127.0.0.1:1234/v1/"), "http://127.0.0.1:1234");
});

test("strips whitespace and other version segments", () => {
  assert.strictEqual(normalizeBaseUrl("  http://host:8080/v2  "), "http://host:8080");
});

test("does not strip a path that merely contains v1", () => {
  assert.strictEqual(normalizeBaseUrl("http://host/v1proxy"), "http://host/v1proxy");
});
