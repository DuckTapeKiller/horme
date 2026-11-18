import type { HormeSettings } from "../../types";
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
