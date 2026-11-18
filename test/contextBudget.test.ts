import { test } from "node:test";
import assert from "node:assert/strict";
import { fitPassages, fitText, passageBudget, roundBudget } from "../src/utils/contextBudget";

void test("Apple's 8,192-token window leaves room for a few passages beside a 16,000-character prompt", () => {
  const budget = passageBudget(8192, 16000);
  assert.ok(budget > 3000 && budget < 8000, String(budget));
  const passages = Array.from({ length: 20 }, (_, i) => `passage ${i} `.padEnd(950, "x"));
  const fitted = fitPassages(passages, budget);
  assert.ok(fitted.length >= 3 && fitted.length <= 8, String(fitted.length));
  assert.equal(fitted[0], passages[0]);
});

void test("nothing fits when the rest of the request already fills the window", () => {
  assert.equal(passageBudget(8192, 40000), 0);
  assert.deepEqual(fitPassages(["a".repeat(10)], 0), []);
});

void test("a large window takes all twenty passages", () => {
  const passages = Array.from({ length: 20 }, () => "y".repeat(950));
  assert.equal(fitPassages(passages, passageBudget(131072, 16000)).length, 20);
});

void test("text over the budget is cut at a line end and says so", () => {
  const text = Array.from({ length: 50 }, (_, i) => `Line ${i} of the page.`).join("\n");
  const cut = fitText(text, 300);
  assert.ok(cut.length <= 300);
  assert.ok(cut.endsWith("[…cut to fit the model's context window]"));
  assert.ok(/of the page\.\n\n\[…cut/.test(cut));
  assert.equal(fitText("short", 300), "short");
  assert.ok(roundBudget(8192) < 8192 * 3.3);
});
