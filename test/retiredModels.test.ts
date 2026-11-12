import { test } from "node:test";
import assert from "node:assert/strict";
import { RETIRED_MODELS, replaceRetiredModels } from "../src/utils/retiredModels";
import { PROVIDER_MODELS } from "../src/constants";
import type { AiProvider, HormeSettings } from "../src/types";

const KEYS: Record<string, string> = {
  claude: "claudeModel",
  gemini: "geminiModel",
  openai: "openaiModel",
  groq: "groqModel",
  openrouter: "openRouterModel",
  mistral: "mistralModel",
};
const modelKey = (p: AiProvider) => KEYS[p];

void test("a retired model saved on the phone moves to its replacement", () => {
  const s = {
    mistralModel: "pixtral-large-latest",
    groqModel: "llama-3.1-70b-versatile",
    openaiModel: "gpt-4o-mini",
    mobileProvider: "mistral",
    mobileModel: "pixtral-large-latest",
  } as unknown as HormeSettings;
  const moves = replaceRetiredModels(s, modelKey);
  assert.equal(s.mistralModel, "mistral-large-4");
  assert.equal(s.mobileModel, "mistral-large-4");
  assert.equal(s.groqModel, "openai/gpt-oss-120b");
  assert.equal(s.openaiModel, "gpt-4o-mini"); // deprecated, not yet shut down: left alone
  assert.deepEqual(
    moves.map((m) => `${m.provider}:${m.from}`),
    ["mistral:pixtral-large-latest", "groq:llama-3.1-70b-versatile"],
  );
});

void test("Mistral NeMo is kept: it still answers", () => {
  const s = {
    mistralModel: "open-mistral-nemo",
    mobileProvider: "mistral",
    mobileModel: "open-mistral-nemo",
  } as unknown as HormeSettings;
  assert.equal(replaceRetiredModels(s, modelKey).length, 0);
  assert.equal(s.mistralModel, "open-mistral-nemo");
  assert.equal(s.mobileModel, "open-mistral-nemo");
  assert.equal(PROVIDER_MODELS.mistral[0], "open-mistral-nemo");
});

void test("a model ID is only replaced under its own provider", () => {
  const s = { mobileProvider: "openrouter", mobileModel: "gpt-3.5-turbo" } as unknown as HormeSettings;
  assert.equal(replaceRetiredModels(s, modelKey).length, 0);
  assert.equal(s.mobileModel, "gpt-3.5-turbo");
});

void test("no replacement is itself retired, and the menus offer none of the retired models", () => {
  for (const [provider, table] of Object.entries(RETIRED_MODELS)) {
    for (const { to } of Object.values(table)) assert.equal(table[to], undefined, `${provider}: ${to}`);
    for (const offered of PROVIDER_MODELS[provider] ?? [])
      assert.equal(table[offered], undefined, `${provider} menu offers ${offered}`);
  }
});
