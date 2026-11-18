import { test } from "node:test";
import assert from "node:assert/strict";
import { thinkingSwitchAtTop } from "../src/utils/chatTemplate";

void test("gemma 4 writes its thinking switch at the top of the prompt", () => {
  const on = "<|turn>system\n<|think|>\nProbe<turn|>\n<|turn>user\nQuestion<turn|>\n<|turn>model\n";
  const off = "<|turn>system\nProbe<turn|>\n<|turn>user\nQuestion<turn|>\n<|turn>model\n";
  assert.equal(thinkingSwitchAtTop(on, off, "Question"), true);
});

void test("qwen-style templates close an empty thinking block at the end", () => {
  const on =
    "<|im_start|>system\nProbe<|im_end|>\n<|im_start|>user\nQuestion<|im_end|>\n<|im_start|>assistant\n";
  const off = `${on}<think>\n\n</think>\n\n`;
  assert.equal(thinkingSwitchAtTop(on, off, "Question"), false);
});

void test("a template without a switch renders the same prompt", () => {
  const p = "<s>[INST] Probe\nQuestion [/INST]";
  assert.equal(thinkingSwitchAtTop(p, p, "Question"), false);
});
