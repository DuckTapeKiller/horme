import { test } from "node:test";
import assert from "node:assert/strict";
import {
  claudeAcceptsTemperature,
  isOpenAiReasoningModel,
  mergeConsecutiveTurns,
  splitSystemMessages,
} from "../src/utils/messageRoles";

void test("later system messages become user turns", () => {
  const { system, turns } = splitSystemMessages([
    { role: "system", content: "rules" },
    { role: "user", content: "check this" },
    { role: "assistant", content: "<call:wikipedia>{}</call>" },
    { role: "system", content: "RESULT FROM SKILL" },
    { role: "tool_result", content: "more" },
  ]);
  assert.equal(system, "rules");
  assert.deepEqual(
    turns.map((t) => t.role),
    ["user", "assistant", "user", "user"],
  );
  assert.equal(turns[2].content, "RESULT FROM SKILL");
});

void test("consecutive turns of one role are joined", () => {
  const merged = mergeConsecutiveTurns([
    { role: "user", content: "a" },
    { role: "user", content: "b" },
    { role: "assistant", content: "c" },
  ]);
  assert.deepEqual(merged, [
    { role: "user", content: "a\n\nb" },
    { role: "assistant", content: "c" },
  ]);
});

void test("temperature only for Claude models that take it", () => {
  assert.equal(claudeAcceptsTemperature("claude-3-5-haiku-latest"), true);
  assert.equal(claudeAcceptsTemperature("claude-sonnet-4-5-20250929"), true);
  assert.equal(claudeAcceptsTemperature("claude-haiku-4-5"), true);
  assert.equal(claudeAcceptsTemperature("claude-opus-4-6"), true);
  assert.equal(claudeAcceptsTemperature("claude-opus-4-7"), false);
  assert.equal(claudeAcceptsTemperature("claude-opus-5-5"), false);
  assert.equal(claudeAcceptsTemperature("claude-sonnet-5"), false);
  assert.equal(claudeAcceptsTemperature("claude-fable-5-1"), false);
});

void test("OpenAI reasoning models are recognised", () => {
  assert.equal(isOpenAiReasoningModel("o3-mini"), true);
  assert.equal(isOpenAiReasoningModel("gpt-5"), true);
  assert.equal(isOpenAiReasoningModel("gpt-5.6-terra"), true);
  assert.equal(isOpenAiReasoningModel("gpt-6-astra"), true);
  assert.equal(isOpenAiReasoningModel("gpt-6.1-sol"), true);
  assert.equal(isOpenAiReasoningModel("gpt-10"), true);
  assert.equal(isOpenAiReasoningModel("gpt-4o-mini"), false);
  assert.equal(isOpenAiReasoningModel("gpt-4.1"), false);
  assert.equal(isOpenAiReasoningModel("gpt-3.5-turbo"), false);
});
