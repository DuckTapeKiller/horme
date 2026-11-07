import { test } from "node:test";
import assert from "node:assert/strict";
import {
  asNumberArray,
  asStringArray,
  getStringProp,
  getNumberProp,
  errorToMessage,
  isNumber,
} from "../src/utils/TypeGuards";

void test("asNumberArray accepts finite-number arrays, rejects otherwise", () => {
  assert.deepEqual(asNumberArray([1, 2, 3]), [1, 2, 3]);
  assert.equal(asNumberArray([1, "2"]), null);
  assert.equal(asNumberArray([1, NaN]), null);
  assert.equal(asNumberArray("nope"), null);
});

void test("asStringArray accepts string arrays, rejects mixed", () => {
  assert.deepEqual(asStringArray(["a", "b"]), ["a", "b"]);
  assert.equal(asStringArray(["a", 1]), null);
  assert.equal(asStringArray({}), null);
});

void test("getStringProp returns string props only", () => {
  assert.equal(getStringProp({ k: "v" }, "k"), "v");
  assert.equal(getStringProp({ k: 1 }, "k"), undefined);
  assert.equal(getStringProp(null, "k"), undefined);
});

void test("getNumberProp returns finite-number props only", () => {
  assert.equal(getNumberProp({ k: 5 }, "k"), 5);
  assert.equal(getNumberProp({ k: "5" }, "k"), undefined);
  assert.equal(getNumberProp({ k: NaN }, "k"), undefined);
});

void test("isNumber rejects NaN and non-numbers", () => {
  assert.equal(isNumber(3), true);
  assert.equal(isNumber(NaN), false);
  assert.equal(isNumber("3"), false);
});

void test("errorToMessage handles Error, string, and object", () => {
  assert.equal(errorToMessage(new Error("boom")), "boom");
  assert.equal(errorToMessage("plain"), "plain");
  assert.equal(errorToMessage({ a: 1 }), '{"a":1}');
});
