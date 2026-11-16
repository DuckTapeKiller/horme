import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyMobileOverride,
  parsePhoneChoice,
  removeMobileOverride,
  settingsForDisk,
  syncMobileOverride,
  type MobileOverride,
  type PhoneChoice,
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

/** A copy of the settings file, as another device or a restart reads it. */
const copy = (disk: HormeSettings): HormeSettings => JSON.parse(JSON.stringify(disk)) as HormeSettings;

/** The choice as the phone's own storage gives it back after a restart. */
const stored = (o: MobileOverride): PhoneChoice | null =>
  parsePhoneChoice(JSON.parse(JSON.stringify(o.choice)) as unknown);

/** What the phone has in memory after Obsidian restarts with this file and its own stored choice. */
function reopen(disk: HormeSettings, choice: PhoneChoice | null = null): HormeSettings {
  const s = copy(disk);
  applyMobileOverride(s, modelKey, choice);
  return s;
}

void test("a model picked in the phone's chat is still chosen after the app reopens", () => {
  const s = desktopSettings();
  const o = applyMobileOverride(s, modelKey);
  assert.equal(s.aiProvider, "mistral");
  assert.equal(s.mistralModel, "mistral-large-latest"); // no mobile model yet: the desktop's
  assert.equal(o.choice, null);

  s.mistralModel = "open-mistral-nemo"; // the chat's model menu
  syncMobileOverride(s, o, modelKey, 1000);
  const disk = settingsForDisk(s, o, modelKey);

  assert.equal(disk.aiProvider, "llamacpp");
  assert.equal(disk.mistralModel, "mistral-large-latest");
  assert.equal(s.mistralModel, "open-mistral-nemo"); // memory stays the phone's
  assert.deepEqual(o.choice, { provider: "mistral", model: "open-mistral-nemo", at: 1000 });

  const after = reopen(disk, stored(o));
  assert.equal(after.aiProvider, "mistral");
  assert.equal(after.mistralModel, "open-mistral-nemo");
});

void test("the phone's pick stays out of the settings file", () => {
  const s = desktopSettings({ mobileModel: "mistral-small-latest" });
  const o = applyMobileOverride(s, modelKey);
  s.mistralModel = "open-mistral-nemo";
  syncMobileOverride(s, o, modelKey, 1000);
  const disk = settingsForDisk(s, o, modelKey);
  assert.equal(disk.mobileProvider, "mistral");
  assert.equal(disk.mobileModel, "mistral-small-latest"); // what the file had
  assert.equal(s.mobileModel, "open-mistral-nemo"); // what the phone shows
});

void test("another device saving its old copy of the settings does not undo the phone's pick", () => {
  // A computer loaded the settings before the phone picked, and keeps them in memory.
  const onComputer = desktopSettings({ mobileModel: "mistral-small-latest" });

  const s = copy(onComputer);
  const o = applyMobileOverride(s, modelKey);
  s.mistralModel = "open-mistral-nemo";
  syncMobileOverride(s, o, modelKey, 1000);
  settingsForDisk(s, o, modelKey); // the phone's save, later replaced by sync

  // The computer saves for a reason of its own and sync brings its file to the phone.
  const after = reopen(onComputer, stored(o));
  assert.equal(after.aiProvider, "mistral");
  assert.equal(after.mistralModel, "open-mistral-nemo");
});

void test("the file's mobile model changing without a computer's On mobile page leaves the phone's pick", () => {
  // 4.0.4 wrote picks to the file, so devices can still hold different mobile models.
  const s = desktopSettings({ mobileProvider: "gemini", mobileModel: "gemini-3.6-flash" });
  const o = applyMobileOverride(s, modelKey);
  assert.equal(s.geminiModel, "gemini-3.6-flash");
  s.geminiModel = "gemini-4-carbon";
  syncMobileOverride(s, o, modelKey, 5);
  // The file flips to yet another value while devices catch up with each other.
  const flipped = desktopSettings({ mobileProvider: "gemini", mobileModel: "gemini-3.8-flash" });
  assert.equal(reopen(flipped, stored(o)).geminiModel, "gemini-4-carbon");
});

void test("a mobile model set on a computer after the phone's pick replaces it", () => {
  const s = desktopSettings({ mobileModel: "mistral-small-latest" });
  const o = applyMobileOverride(s, modelKey);
  s.mistralModel = "open-mistral-nemo";
  syncMobileOverride(s, o, modelKey, 1000);

  // On mobile page of a computer, later.
  const disk = desktopSettings({ mobileModel: "mistral-large-4", mobileChangedAt: 2000 });
  const s2 = copy(disk);
  const o2 = applyMobileOverride(s2, modelKey, stored(o));
  assert.equal(s2.mistralModel, "mistral-large-4");
  assert.equal(o2.choice, null); // the phone follows the file again

  // A pick on the phone after that holds again.
  s2.mistralModel = "codestral-latest";
  syncMobileOverride(s2, o2, modelKey, 3000);
  assert.equal(reopen(disk, stored(o2)).mistralModel, "codestral-latest");
});

void test("a mobile model set on a computer before the phone's pick does not replace it", () => {
  const disk = desktopSettings({ mobileModel: "mistral-large-4", mobileChangedAt: 500 });
  const after = reopen(disk, { provider: "mistral", model: "open-mistral-nemo", at: 1000 });
  assert.equal(after.mistralModel, "open-mistral-nemo");
});

void test("the copy for disk leaves the settings in memory alone", () => {
  const s = desktopSettings({ mobileModel: "mistral-small-latest" });
  const o = applyMobileOverride(s, modelKey);
  settingsForDisk(s, o, modelKey);
  assert.equal(s.aiProvider, "mistral");
  assert.equal(s.mistralModel, "mistral-small-latest");
});

void test("a provider picked on the phone's Models page becomes the phone's provider", () => {
  const s = desktopSettings({ mobileModel: "open-mistral-nemo" });
  const o = applyMobileOverride(s, modelKey);
  s.aiProvider = "openai";
  syncMobileOverride(s, o, modelKey, 1000);
  assert.equal(s.mobileProvider, "openai");
  assert.equal(s.mobileModel, "gpt-4o-mini");
  assert.equal(s.mistralModel, "mistral-large-latest"); // Mistral's desktop model is back

  s.openaiModel = "gpt-5-mini";
  syncMobileOverride(s, o, modelKey, 2000);
  const disk = settingsForDisk(s, o, modelKey);
  assert.equal(disk.aiProvider, "llamacpp");
  assert.equal(disk.openaiModel, "gpt-4o-mini");
  assert.equal(disk.mistralModel, "mistral-large-latest");
  assert.equal(disk.mobileProvider, "mistral"); // the file keeps what it had
  assert.equal(disk.mobileModel, "open-mistral-nemo");
  assert.deepEqual(o.choice, { provider: "openai", model: "gpt-5-mini", at: 2000 });

  const after = reopen(disk, stored(o));
  assert.equal(after.aiProvider, "openai");
  assert.equal(after.openaiModel, "gpt-5-mini");
  assert.equal(after.mistralModel, "mistral-large-latest");
});

void test("a change on the phone's On mobile page takes effect at once and is kept", () => {
  const s = desktopSettings();
  const o = applyMobileOverride(s, modelKey);

  s.mobileModel = "mistral-medium-latest";
  syncMobileOverride(s, o, modelKey, 1000);
  assert.equal(s.mistralModel, "mistral-medium-latest");

  // A new mobile provider clears the mobile model (the settings page does that).
  s.mobileProvider = "gemini";
  s.mobileModel = "";
  syncMobileOverride(s, o, modelKey, 2000);
  assert.equal(s.aiProvider, "gemini");
  assert.equal(s.geminiModel, "gemini-2.5-flash");
  assert.equal(s.mistralModel, "mistral-large-latest");

  const disk = settingsForDisk(s, o, modelKey);
  assert.equal(disk.aiProvider, "llamacpp");
  assert.equal(disk.mobileProvider, "mistral");
  const after = reopen(disk, stored(o));
  assert.equal(after.aiProvider, "gemini");
  assert.equal(after.geminiModel, "gemini-2.5-flash");
});

void test("clearing the phone's model falls back to the desktop's for that provider", () => {
  const s = desktopSettings({ mobileModel: "open-mistral-nemo" });
  const o = applyMobileOverride(s, modelKey);
  s.mistralModel = "";
  syncMobileOverride(s, o, modelKey, 1000);
  assert.equal(s.mobileModel, "");
  assert.equal(reopen(settingsForDisk(s, o, modelKey), stored(o)).mistralModel, "mistral-large-latest");
});

void test("the same provider on both keeps two models apart", () => {
  const s = desktopSettings({ aiProvider: "mistral", mobileModel: "ministral-8b-latest" });
  const o = applyMobileOverride(s, modelKey);
  assert.equal(s.mistralModel, "ministral-8b-latest");
  s.mistralModel = "mistral-small-latest";
  syncMobileOverride(s, o, modelKey, 1000);
  const disk = settingsForDisk(s, o, modelKey);
  assert.equal(disk.aiProvider, "mistral");
  assert.equal(disk.mistralModel, "mistral-large-latest");
  assert.equal(disk.mobileModel, "ministral-8b-latest");
  assert.equal(reopen(disk, stored(o)).mistralModel, "mistral-small-latest");
});

void test("switching the override off puts the desktop's provider and model back", () => {
  const s = desktopSettings({ mobileModel: "open-mistral-nemo" });
  const o = applyMobileOverride(s, modelKey);
  s.mistralModel = "codestral-latest";
  syncMobileOverride(s, o, modelKey, 1000);
  removeMobileOverride(s, o, modelKey);
  assert.equal(s.aiProvider, "llamacpp");
  assert.equal(s.mistralModel, "mistral-large-latest");
  assert.equal(s.mobileProvider, "mistral");
  assert.equal(s.mobileModel, "open-mistral-nemo"); // the file's, not the phone's pick
});

void test("nothing changes when nothing was picked", () => {
  const s = desktopSettings({ mobileModel: "open-mistral-nemo" });
  const o = applyMobileOverride(s, modelKey);
  const before = JSON.stringify(s);
  syncMobileOverride(s, o, modelKey, 1000);
  assert.equal(JSON.stringify(s), before);
  assert.equal(o.choice, null);
});

void test("a stored choice that is not one is ignored", () => {
  assert.equal(parsePhoneChoice(null), null);
  assert.equal(parsePhoneChoice("gemini"), null);
  assert.equal(parsePhoneChoice({ provider: "gemini", model: "x" }), null);
  assert.equal(parsePhoneChoice({ provider: "", model: "x", at: 1 }), null);
  assert.deepEqual(parsePhoneChoice({ provider: "gemini", model: " x ", at: 1 }), {
    provider: "gemini",
    model: "x",
    at: 1,
  });
});
