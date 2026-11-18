import type { AiProvider, HormeSettings } from "../types";
import { isLoopbackUrl } from "./urlSafety";

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
export function keepsNotesPrivate(s: PrivacySettings, id: AiProvider, model?: string): boolean {
  // Ollama runs its cloud models on its own servers: notes sent to one leave.
  if (id === "ollama") return !isOllamaCloudModel(model ?? s.defaultModel);
  return isLocalServer(id) || (id === "custom" && customServerIsMine(s));
}

/** What the privacy rule reads: the OpenAI-compatible server's trust, and Ollama's chat model. */
export type PrivacySettings = CustomTrust & Partial<Pick<HormeSettings, "defaultModel">>;

/**
 * Ollama's cloud models ("gpt-oss:120b-cloud", "glm-4.6:cloud"): Ollama on
 * this computer passes requests for them to ollama.com.
 */
export function isOllamaCloudModel(model: string | undefined): boolean {
  return /[:-]cloud$/i.test((model ?? "").trim());
}

/**
 * Where the chat's requests go, for the privacy questions a cloud provider
 * asks once: the provider, plus what changes the destination within it (the
 * OpenAI-compatible server's address, Ollama's model). A new destination
 * asks again.
 */
export function notesDestination(
  s: Pick<HormeSettings, "customUrl"> & Partial<Pick<HormeSettings, "defaultModel">>,
  id: AiProvider,
): string {
  if (id === "custom") return `custom@${compatBaseUrl(s.customUrl)}`;
  if (id === "ollama") return `ollama:${(s.defaultModel ?? "").trim()}`;
  return id;
}

/** What decides whether the OpenAI-compatible server is the user's own. */
export type CustomTrust = Pick<HormeSettings, "customIsLocal" | "customUrl" | "customTrustedUrl">;

/**
 * True while the user's "This server is mine" still applies: it is on, and the
 * server's address is the one they confirmed. Pointing the provider at another
 * address (by hand, or a settings file synced from another device) ends it, so
 * notes never follow a changed address without a new confirmation.
 */
export function customServerIsMine(s: CustomTrust): boolean {
  if (s.customIsLocal !== true) return false;
  const now = compatBaseUrl(s.customUrl ?? "");
  return now !== "" && now === compatBaseUrl(s.customTrustedUrl ?? "");
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
export function embeddingSourceAllowed(s: Pick<HormeSettings, "embeddingSource"> & CustomTrust): boolean {
  return isLocalServer(s.embeddingSource) || (s.embeddingSource === "custom" && customServerIsMine(s));
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

/** Where the chosen embedding server lives. */
export function embeddingAddress(
  s: Pick<
    HormeSettings,
    "embeddingSource" | "llamaCppEmbeddingUrl" | "lmStudioUrl" | "customUrl" | "ollamaBaseUrl"
  >,
): string {
  const p = s.embeddingSource;
  if (p === "llamacpp") return s.llamaCppEmbeddingUrl.trim();
  if (p === "lmstudio") return s.lmStudioUrl.trim();
  if (p === "custom") return s.customUrl.trim();
  return s.ollamaBaseUrl.trim();
}

/**
 * Why Vault Brain cannot use its embedding server here, or null when it can.
 * Two things stop it: a server that may not be sent notes (the
 * OpenAI-compatible server no longer marked as the user's own), and, on a
 * phone or tablet, an address such as 127.0.0.1 that means the device itself.
 * Then nothing is indexed and searches find notes by their words only, rather
 * than every change failing and rewriting the index.
 */
export function embeddingBlock(
  s: Parameters<typeof embeddingAddress>[0] & Pick<HormeSettings, "embeddingSource"> & CustomTrust,
  onMobile: boolean,
): string | null {
  if (!embeddingSourceAllowed(s))
    return 'Vault Brain is paused: the OpenAI-compatible server is not marked as yours, so your notes are not sent to it. Turn on "This server is mine" on its page in Models, or choose another embedding server under Vault Brain.';
  const address = embeddingAddress(s);
  if (onMobile && isLoopbackUrl(address))
    return `Vault Brain cannot reach its embedding server from this device: ${address} is the device itself, not your computer. Notes are found by their words instead. To use it here, give the embedding server a network address under Vault Brain.`;
  return null;
}
