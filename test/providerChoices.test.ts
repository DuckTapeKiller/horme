import { test } from "node:test";
import assert from "node:assert";
import { chatProviderChoices } from "../src/views/settings/providers";
import { DEFAULT_SETTINGS } from "../src/constants";
import type { AiProvider, HormeSettings } from "../src/types";

const settings = (over: Partial<HormeSettings> = {}): HormeSettings => ({ ...DEFAULT_SETTINGS, ...over });
const keys =
  (have: Partial<Record<AiProvider, string>>) =>
  (p: AiProvider): string =>
    have[p] ?? "";

void test("chat provider menu: the user's own providers first, then the cloud ones", () => {
  const ids = chatProviderChoices(settings(), keys({})).map((c) => `${c.own ? "own" : "cloud"}:${c.id}`);
  assert.deepStrictEqual(ids, [
    "own:llamacpp",
    "own:ollama",
    "own:lmstudio",
    "cloud:claude",
    "cloud:gemini",
    "cloud:openai",
    "cloud:groq",
    "cloud:openrouter",
    "cloud:mistral",
    "cloud:custom",
  ]);
});

void test("chat provider menu: cloud services without a key, and a server without an address, say so", () => {
  const choices = chatProviderChoices(settings({ customUrl: "" }), keys({ gemini: "k", openrouter: " " }));
  const missing = Object.fromEntries(choices.map((c) => [c.id, c.missing]));
  assert.strictEqual(missing.llamacpp, "");
  assert.strictEqual(missing.gemini, "");
  assert.strictEqual(missing.claude, "no key");
  assert.strictEqual(missing.openrouter, "no key");
  assert.strictEqual(missing.custom, "no address");
});

void test("chat provider menu: the OpenAI-compatible server marked as the user's own sits with the local ones", () => {
  const url = "http://192.168.1.20:4000/v1";
  const s = settings({ customUrl: url, customIsLocal: true, customTrustedUrl: url });
  const custom = chatProviderChoices(s, keys({})).find((c) => c.id === "custom");
  assert.deepStrictEqual(custom && { own: custom.own, missing: custom.missing }, { own: true, missing: "" });
  const ids = chatProviderChoices(s, keys({})).map((c) => c.id);
  assert.ok(ids.indexOf("custom") < ids.indexOf("claude"));
});

void test("chat provider menu: Apple Intelligence is never offered on a phone", () => {
  assert.ok(!chatProviderChoices(settings(), keys({}), true).some((c) => c.id === "apple"));
});
