import { test } from "node:test";
import assert from "node:assert";
import { repairSettings } from "../src/utils/settingsRepair";
import { DEFAULT_SETTINGS } from "../src/constants";
import type { HormeSettings } from "../src/types";

const settings = (over: Partial<HormeSettings>): HormeSettings => ({
  ...structuredClone(DEFAULT_SETTINGS),
  ...over,
});

void test("defaults need no repair", () => {
  assert.deepStrictEqual(repairSettings(settings({})), { changed: false, notices: [] });
});

void test("numbers out of range go back to their defaults", () => {
  const s = settings({ temperature: 7, maxTokens: Number.NaN });
  assert.strictEqual(repairSettings(s).changed, true);
  assert.strictEqual(s.temperature, DEFAULT_SETTINGS.temperature);
  assert.strictEqual(s.maxTokens, DEFAULT_SETTINGS.maxTokens);
});

void test("an old 'this server is mine' keeps a local address and drops an internet one, saying so", () => {
  const lan = settings({
    customIsLocal: true,
    customUrl: "http://192.168.1.20:4000/v1",
    customTrustedUrl: "",
  });
  assert.deepStrictEqual(repairSettings(lan), { changed: true, notices: [] });
  assert.strictEqual(lan.customTrustedUrl, "http://192.168.1.20:4000/v1");
  const net = settings({
    customIsLocal: true,
    customUrl: "https://api.example.com/v1",
    customTrustedUrl: "",
  });
  const r = repairSettings(net);
  assert.strictEqual(net.customIsLocal, false);
  assert.strictEqual(r.notices.length, 1);
  assert.match(r.notices[0], /api\.example\.com/);
});

void test("a cloud tags provider without consent falls back to a local one", () => {
  const s = settings({
    allowCloudRAG: false,
    tagsProvider: "gemini",
    tagsModel: "gemini-2.5-flash",
    aiProvider: "llamacpp",
  });
  repairSettings(s);
  assert.strictEqual(s.tagsProvider, "llamacpp");
  assert.strictEqual(s.tagsModel, "");
});
