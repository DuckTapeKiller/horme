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

/** The servers that may make embeddings. */
export type EmbeddingSource = HormeSettings["embeddingSource"];

export function isEmbeddingSource(v: unknown): v is EmbeddingSource {
  return v === "llamacpp" || v === "lmstudio" || v === "ollama" || v === "custom";
}

/**
 * True when the chosen embedding server may be sent notes. Building the index
 * sends the full text of every note, so only servers the user runs qualify:
 * the local servers, and the OpenAI-compatible server only while the user
 * says it is theirs. There is no fallback to another server.
 */
export function embeddingSourceAllowed(s: Pick<HormeSettings, "embeddingSource" | "customIsLocal">): boolean {
  return isLocalServer(s.embeddingSource) || (s.embeddingSource === "custom" && s.customIsLocal === true);
}

/**
 * The embedding server for settings saved before it could be chosen: the one
 * their index was built with, so no index has to be rebuilt. That was the chat
 * provider when it was a local server, and Ollama for every other provider.
 * Returns null when nothing needs setting: a valid choice is already saved,
 * or this is a new install (no saved settings), which takes the default.
 */
export function initialEmbeddingSource(
  saved: Record<string, unknown>,
  defaultChatProvider: string,
): EmbeddingSource | null {
  if (isEmbeddingSource(saved.embeddingSource)) return null;
  if (Object.keys(saved).length === 0) return null;
  const chat = typeof saved.aiProvider === "string" ? saved.aiProvider : defaultChatProvider;
  return isLocalServer(chat) ? chat : "ollama";
}
