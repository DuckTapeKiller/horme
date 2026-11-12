import type { AiProvider, HormeSettings } from "../types";

interface Retired {
  /** The provider's recommended replacement, followed to a model still served. */
  to: string;
  /** When the provider stopped serving it, as the provider gives it. */
  gone?: string;
}

/**
 * Cloud model IDs Horme once offered (or that the providers' tables name) and
 * that their providers no longer serve, with the replacement each provider
 * recommends. Where the replacement was itself retired later, the chain is
 * followed. Read from the providers' deprecation pages on 12 November 2026.
 * The providers say these no longer answer, so a saved one is moved on at
 * start-up, with a notice.
 */
export const RETIRED_MODELS: Partial<Record<AiProvider, Record<string, Retired>>> = {
  mistral: {
    // Mistral NeMo is not here: Mistral lists it as retired on 31 July 2026, but
    // it still answered on 12 November 2026.
    // Pixtral Large → Mistral Medium 3.5, deprecated in turn for Mistral Large 4.
    "pixtral-large-latest": { to: "mistral-large-4", gone: "31 May 2026" },
    "pixtral-large-2411": { to: "mistral-large-4", gone: "31 May 2026" },
  },
  openai: {
    "gpt-3.5-turbo": { to: "gpt-5.6-terra", gone: "23 October 2026" },
  },
  groq: {
    // Shut down for free and developer keys; enterprise contracts keep them.
    "llama-3.3-70b-versatile": { to: "openai/gpt-oss-120b", gone: "16 August 2026" },
    "llama-3.1-8b-instant": { to: "openai/gpt-oss-20b", gone: "16 August 2026" },
    "llama-3.1-70b-versatile": { to: "openai/gpt-oss-120b", gone: "24 January 2025" },
    "mixtral-8x7b-32768": { to: "openai/gpt-oss-120b", gone: "20 March 2025" },
    "gemma2-9b-it": { to: "openai/gpt-oss-20b", gone: "8 October 2025" },
  },
  claude: {
    "claude-3-5-haiku-latest": { to: "claude-haiku-4-5-20251001", gone: "19 February 2026" },
    "claude-3-5-sonnet-latest": { to: "claude-sonnet-5-5", gone: "28 October 2025" },
    "claude-3-5-sonnet-20240620": { to: "claude-sonnet-5-5", gone: "28 October 2025" },
    "claude-3-opus-latest": { to: "claude-opus-4-8", gone: "5 January 2026" },
  },
  gemini: {
    "gemini-2.0-flash": { to: "gemini-3.6-flash", gone: "1 June 2026" },
  },
  // Gone from OpenRouter's model list, with no named replacement: Horme's free default.
  openrouter: {
    "mistralai/mistral-7b-instruct:free": { to: "google/gemma-4-31b-it:free" },
    "google/gemma-7b-it:free": { to: "google/gemma-4-31b-it:free" },
    "openchat/openchat-7b:free": { to: "google/gemma-4-31b-it:free" },
  },
};

export interface ModelMove {
  provider: AiProvider;
  from: string;
  to: string;
  gone?: string;
}

/**
 * Replaces retired models in the settings: each cloud provider's chat model
 * and the mobile model. Returns what was moved, for a notice.
 */
export function replaceRetiredModels(
  s: HormeSettings,
  modelKey: (provider: AiProvider) => string,
): ModelMove[] {
  const moves: ModelMove[] = [];
  const rec = s as unknown as Record<string, unknown>;
  const fields: Array<[AiProvider, string]> = (Object.keys(RETIRED_MODELS) as AiProvider[]).map((p) => [
    p,
    modelKey(p),
  ]);
  fields.push([s.mobileProvider, "mobileModel"]);
  for (const [provider, key] of fields) {
    const value = rec[key];
    if (typeof value !== "string") continue;
    const hit = RETIRED_MODELS[provider]?.[value.trim()];
    if (!hit) continue;
    rec[key] = hit.to;
    if (!moves.some((m) => m.provider === provider && m.from === value.trim()))
      moves.push({ provider, from: value.trim(), to: hit.to, gone: hit.gone });
  }
  return moves;
}
