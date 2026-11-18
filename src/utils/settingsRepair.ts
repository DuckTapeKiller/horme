import { DEFAULT_SETTINGS } from "../constants";
import type { HormeSettings } from "../types";
import { normalizeImageSources } from "./imageSources";
import { compatBaseUrl, keepsNotesPrivate } from "./providerAccess";
import { isPublicHttpUrl } from "./urlSafety";

/**
 * Repairs values the settings page can no longer produce: numbers that are not
 * numbers, and cloud choices whose consent was later withdrawn or that belong
 * to another address. Returns whether anything changed, and what to tell the
 * user about it.
 */
export function repairSettings(s: HormeSettings): { changed: boolean; notices: string[] } {
  let changed = false;
  const notices: string[] = [];
  const numbers: Array<[keyof HormeSettings, number, number]> = [
    ["temperature", 0, 1],
    ["maxTokens", 256, 1_000_000],
    ["agentMaxRounds", 1, 50],
    ["contextFoldersMaxChars", 1000, 10_000_000],
    ["connectionsThreshold", 0, 1],
    ["connectionsMaxResults", 1, 200],
    ["maxSuggestedTags", 1, 100],
    ["maxHighlightsPerNote", 1, 1000],
    ["maxHighlightCharsPerNote", 1, 1_000_000],
    ["vaultBrainRrfK", 1, 10_000],
    ["vaultIndexPdfMaxChars", 1000, 100_000_000],
    ["highlightBoost", 0, 10],
    ["searchMetadataCap", 0, 10],
    ["searchContentCap", 0, 10],
    ["imageMaxCount", 1, 8],
  ];
  for (const [key, min, max] of numbers) {
    const v = s[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
      (s as unknown as Record<string, unknown>)[key] = DEFAULT_SETTINGS[key];
      changed = true;
    }
  }
  // A fresh copy, so later edits never touch the defaults; new sources are appended.
  const sources = normalizeImageSources(s.imageSources);
  if (JSON.stringify(sources) !== JSON.stringify(s.imageSources)) changed = true;
  s.imageSources = sources;
  if (!["off", "wikipedia", "always"].includes(s.imagesInAnswers)) {
    s.imagesInAnswers = DEFAULT_SETTINGS.imagesInAnswers;
    changed = true;
  }
  if (!Array.isArray(s.presetsPaths)) {
    s.presetsPaths = [];
    changed = true;
  }
  if (!Array.isArray(s.customSkills)) {
    s.customSkills = [];
    changed = true;
  }
  // "This server is mine" from before it was tied to an address: there is no
  // knowing which address it was given for. A server on this computer or the
  // local network keeps it; an internet address must be confirmed again.
  if (s.customIsLocal && !s.customTrustedUrl) {
    const address = compatBaseUrl(s.customUrl);
    if (address && !isPublicHttpUrl(address)) {
      s.customTrustedUrl = address;
    } else {
      s.customIsLocal = false;
      notices.push(
        `Horme: "This server is mine" is now off for the OpenAI-compatible server at ${address || "no address"}. Turn it on again on its page in Models if you run that server.`,
      );
    }
    changed = true;
  }
  if (!s.allowCloudRAG && !keepsNotesPrivate(s, s.tagsProvider, s.tagsModel.trim() || undefined)) {
    s.tagsProvider = keepsNotesPrivate(s, s.aiProvider) ? s.aiProvider : "ollama";
    s.tagsModel = "";
    changed = true;
  }
  if (
    !s.allowCloudTagTranslation &&
    !keepsNotesPrivate(s, s.tagTranslationProvider, s.tagTranslationModel.trim() || undefined)
  ) {
    s.tagTranslationProvider = s.tagTranslationFallbackProvider;
    changed = true;
  }
  return { changed, notices };
}
