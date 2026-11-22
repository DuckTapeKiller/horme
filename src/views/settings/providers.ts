import type { AiProvider, HormeSettings } from "../../types";
import { customServerIsMine, keepsNotesPrivate, type EmbeddingSource } from "../../utils/providerAccess";
import { PROVIDERS } from "../../providers/registry";
import { AppleModelServer } from "../../services/AppleModelServer";

/**
 * Dropdown options for a provider picker: local ones first, then cloud ones
 * when allowed. The OpenAI-compatible server is offered with the local ones
 * once the user says it is theirs (pass the settings to know).
 */
export function providerOptions(
  includeCloud = true,
  s?: HormeSettings,
  forPhones = false,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of PROVIDERS) {
    // Apple Intelligence runs only on a Mac that has Apple's tool, never on a phone.
    if (p.id === "apple" && (forPhones || !AppleModelServer.onMac())) continue;
    const mine = p.id === "custom" && s !== undefined && keepsNotesPrivate(s, p.id);
    if (!p.local && !includeCloud && !mine) continue;
    out[p.id] = p.id === "custom" ? p.name : p.local ? `${p.name} (local)` : `${p.name} (cloud)`;
  }
  return out;
}

/** A provider in the chat's provider menu. */
export interface ProviderChoice {
  id: AiProvider;
  name: string;
  /** Runs on the user's own machines: a local server, or the OpenAI-compatible server marked as theirs. */
  own: boolean;
  /** What it still needs before it can answer ("no key", "no address"), or "" when nothing. */
  missing: string;
}

/**
 * The providers the chat's provider menu offers, the user's own first, each
 * with what it still needs before it can answer. Apple Intelligence is offered
 * only on a Mac, as in the settings.
 */
export function chatProviderChoices(
  s: HormeSettings,
  keyFor: (id: AiProvider) => string,
  forPhones = false,
): ProviderChoice[] {
  const all: ProviderChoice[] = [];
  for (const p of PROVIDERS) {
    if (p.id === "apple" && (forPhones || !AppleModelServer.onMac())) continue;
    const own = p.local || (p.id === "custom" && customServerIsMine(s));
    const noKey = p.keyRequired && !keyFor(p.id).trim();
    const noAddress = p.urlKey !== undefined && !String(s[p.urlKey] ?? "").trim();
    all.push({ id: p.id, name: p.name, own, missing: noKey ? "no key" : noAddress ? "no address" : "" });
  }
  return [...all.filter((c) => c.own), ...all.filter((c) => !c.own)];
}

/** The embedding server chosen under Vault Brain, whatever answers the chat. */
export function embeddingProvider(s: HormeSettings): EmbeddingSource {
  return s.embeddingSource;
}

/**
 * The servers that may make embeddings: only ones the user runs. The
 * OpenAI-compatible server is offered once the user says it is theirs (and
 * shown, marked paused, while it is chosen but no longer theirs).
 */
export function embeddingOptions(s: HormeSettings): Record<string, string> {
  const out: Record<string, string> = { llamacpp: "llama.cpp", lmstudio: "LM Studio", ollama: "Ollama" };
  if (customServerIsMine(s)) out.custom = "OpenAI-compatible server";
  else if (s.embeddingSource === "custom") out.custom = "OpenAI-compatible server (paused)";
  return out;
}
