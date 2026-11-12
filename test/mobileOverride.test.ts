import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyMobileOverride,
  removeMobileOverride,
  settingsForDisk,
  syncMobileOverride,
} from "../src/utils/mobileOverride";
import type { AiProvider, HormeSettings } from "../src/types";

const KEYS: Record<string, string> = {
  llamacpp: "llamaCppModel",
  gemini: "geminiModel",
  mistral: "mistralModel",
  openai: "openaiModel",
};
const modelKey = (p: AiProvider) => KEYS[p];

/** Only the fields the override touches; the rest of the settings play no part. */
function desktopSettings(over: Record<string, unknown> = {}): HormeSettings {
  return {
    aiProvider: "llamacpp",
    llamaCppModel: "",
    geminiModel: "gemini-2.5-flash",
    mistralModel: "mistral-large-latest",
    openaiModel: "gpt-4o-mini",
    useMobileOverride: true,
    mobileProvider: "mistral",
    mobileModel: "",
    ...over,
  } as unknown as HormeSettings;
}

/** What the phone has in memory after Obsidian restarts with this file. */
function reopen(disk: HormeSettings): HormeSettings {
  const s = JSON.parse(JSON.stringify(disk)) as HormeSettings;
  applyMobileOverride(s, modelKey);
  return s;
}

void test("a model picked in the phone's chat is still chosen after the app reopens", () => {
  const s = desktopSettings();
  const o = applyMobileOverride(s, modelKey);
  assert.equal(s.aiProvider, "mistral");
  assert.equal(s.mistralModel, "mistral-large-latest"); // no mobile model yet: the desktop's

  s.mistralModel = "open-mistral-nemo"; // the chat's model menu
  syncMobileOverride(s, o, modelKey);
  const disk = settingsForDisk(s, o, modelKey);

  assert.equal(disk.aiProvider, "llamacpp");
  assert.equal(disk.mistralModel, "mistral-large-latest");
  assert.equal(disk.mobileModel, "open-mistral-nemo");
  assert.equal(s.mistralModel, "open-mistral-nemo"); // memory stays the phone's

  const after = reopen(disk);
  assert.equal(after.aiProvider, "mistral");
  assert.equal(after.mistralModel, "open-mistral-nemo");
});

void test("the copy for disk leaves the settings in memory alone", () => {
  const s = desktopSettings({ mobileModel: "mistral-small-latest" });
  const o = applyMobileOverride(s, modelKey);
  settingsForDisk(s, o, modelKey);
  assert.equal(s.aiProvider, "mistral");
  assert.equal(s.mistralModel, "mistral-small-latest");
});

void test("a provider picked on the phone's Models page becomes the mobile provider", () => {
  const s = desktopSettings({ mobileModel: "open-mistral-nemo" });
  const o = applyMobileOverride(s, modelKey);
  s.aiProvider = "openai";
  syncMobileOverride(s, o, modelKey);
  assert.equal(s.mobileProvider, "openai");
  assert.equal(s.mobileModel, "gpt-4o-mini");
  assert.equal(s.mistralModel, "mistral-large-latest"); // Mistral's desktop model is back

  s.openaiModel = "gpt-5-mini";
  syncMobileOverride(s, o, modelKey);
  const disk = settingsForDisk(s, o, modelKey);
  assert.equal(disk.aiProvider, "llamacpp");
  assert.equal(disk.openaiModel, "gpt-4o-mini");
  assert.equal(disk.mistralModel, "mistral-large-latest");
  assert.equal(disk.mobileProvider, "openai");
  assert.equal(disk.mobileModel, "gpt-5-mini");
  assert.equal(reopen(disk).openaiModel, "gpt-5-mini");
});

void test("a change on the On mobile page takes effect at once", () => {
  const s = desktopSettings();
  const o = applyMobileOverride(s, modelKey);

  s.mobileModel = "mistral-medium-latest";
  syncMobileOverride(s, o, modelKey);
  assert.equal(s.mistralModel, "mistral-medium-latest");

  // A new mobile provider clears the mobile model (the settings page does that).
  s.mobileProvider = "gemini";
  s.mobileModel = "";
  syncMobileOverride(s, o, modelKey);
  assert.equal(s.aiProvider, "gemini");
  assert.equal(s.geminiModel, "gemini-2.5-flash");
  assert.equal(s.mistralModel, "mistral-large-latest");

  const disk = settingsForDisk(s, o, modelKey);
  assert.equal(disk.aiProvider, "llamacpp");
  assert.equal(disk.mobileProvider, "gemini");
});

void test("clearing the phone's model falls back to the desktop's for that provider", () => {
  const s = desktopSettings({ mobileModel: "open-mistral-nemo" });
  const o = applyMobileOverride(s, modelKey);
  s.mistralModel = "";
  syncMobileOverride(s, o, modelKey);
  assert.equal(s.mobileModel, "");
  assert.equal(reopen(settingsForDisk(s, o, modelKey)).mistralModel, "mistral-large-latest");
});

void test("the same provider on both keeps two models apart", () => {
  const s = desktopSettings({ aiProvider: "mistral", mobileModel: "ministral-8b-latest" });
  const o = applyMobileOverride(s, modelKey);
  assert.equal(s.mistralModel, "ministral-8b-latest");
  s.mistralModel = "mistral-small-latest";
  syncMobileOverride(s, o, modelKey);
  const disk = settingsForDisk(s, o, modelKey);
  assert.equal(disk.aiProvider, "mistral");
  assert.equal(disk.mistralModel, "mistral-large-latest");
  assert.equal(disk.mobileModel, "mistral-small-latest");
});

void test("switching the override off puts the desktop's provider and model back", () => {
  const s = desktopSettings({ mobileModel: "open-mistral-nemo" });
  const o = applyMobileOverride(s, modelKey);
  removeMobileOverride(s, o, modelKey);
  assert.equal(s.aiProvider, "llamacpp");
  assert.equal(s.mistralModel, "mistral-large-latest");
});

void test("nothing changes when nothing was picked", () => {
  const s = desktopSettings({ mobileModel: "open-mistral-nemo" });
  const o = applyMobileOverride(s, modelKey);
  const before = JSON.stringify(s);
  syncMobileOverride(s, o, modelKey);
  assert.equal(JSON.stringify(s), before);
});
