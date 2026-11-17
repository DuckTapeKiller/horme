import type { AiProvider, HormeSettings } from "../types";

/** The servers Horme treats as running on this computer. */
export type LocalServerId = "llamacpp" | "ollama" | "lmstudio";

export function isLocalServer(id: string): id is LocalServerId {
  return id === "llamacpp" || id === "ollama" || id === "lmstudio";
}

/**
 * The Authorization header for a server's API key, or no header at all when
 * there is no key: a server started without one is sent exactly what it was
 * sent before keys existed.
 */
export function bearer(key: string | undefined | null): Record<string, string> {
  const k = (key ?? "").trim();
  return k ? { Authorization: `Bearer ${k}` } : {};
}

/**
 * The base address of an OpenAI-compatible server, as its docs give it: the
 * part before /chat/completions, usually ending in /v1 (LiteLLM, vLLM,
 * DeepSeek) but not always (Open WebUI uses /api, Gemini /v1beta/openai).
 * The version is kept, unlike the local servers' addresses; a pasted endpoint
 * is cut back to its base.
 */
export function compatBaseUrl(raw: string): string {
  return raw
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/(?:chat\/completions|completions|models)$/i, "")
    .replace(/\/+$/, "");
}

/**
 * True when what is sent to a provider stays on the user's own machines: the
 * three local servers, and the OpenAI-compatible server once the user says it
 * is theirs. Every privacy check (Vault Brain, the open note, documents,
 * vault skills, tags) asks this, never the provider's name. A router such as
 * LiteLLM often passes requests on to cloud services, so the
 * OpenAI-compatible server counts as cloud until the user says otherwise.
 */
export function keepsNotesPrivate(s: Pick<HormeSettings, "customIsLocal">, id: AiProvider): boolean {
  return isLocalServer(id) || (id === "custom" && s.customIsLocal === true);
}
