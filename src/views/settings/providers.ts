import { requestUrl } from "obsidian";
import type HormePlugin from "../../../main";
import { PROVIDER_MODELS } from "../../constants";
import type { AiProvider, HormeSettings } from "../../types";
import { asArray, getRecordProp, getStringProp } from "../../utils/TypeGuards";
import { normalizeBaseUrl } from "../../utils/normalizeBaseUrl";
import {
  bearer,
  compatBaseUrl,
  isLocalServer,
  keepsNotesPrivate,
  type EmbeddingSource,
} from "../../utils/providerAccess";
import type { BooleanKey, StringKey } from "./types";

export type LocalProviderId = "llamacpp" | "ollama" | "lmstudio";
export type CloudProviderId = Exclude<AiProvider, LocalProviderId | "custom">;

export interface ProviderInfo {
  id: AiProvider;
  name: string;
  /** Short line shown under the provider's name. */
  blurb: string;
  local: boolean;
  modelKey: StringKey;
  urlKey?: StringKey;
  secretKey?: StringKey;
  /** The provider will not answer without a key (the cloud ones); local servers' keys are optional. */
  keyRequired: boolean;
  /** Example address shown in an empty address field, when the default is empty. */
  urlPlaceholder?: string;
  /** The switch that says this server is the user's own (the OpenAI-compatible server). */
  privateKey?: BooleanKey;
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: "llamacpp",
    name: "llama.cpp",
    blurb: "Runs on this computer through llama-server.",
    local: true,
    modelKey: "llamaCppModel",
    urlKey: "llamaCppUrl",
    secretKey: "llamaCppSecretId",
    keyRequired: false,
  },
  {
    id: "ollama",
    name: "Ollama",
    blurb: "Runs on this computer through Ollama.",
    local: true,
    modelKey: "defaultModel",
    urlKey: "ollamaBaseUrl",
    secretKey: "ollamaSecretId",
    keyRequired: false,
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    blurb: "Runs on this computer through LM Studio's server.",
    local: true,
    modelKey: "lmStudioModel",
    urlKey: "lmStudioUrl",
    secretKey: "lmStudioSecretId",
    keyRequired: false,
  },
  {
    id: "claude",
    name: "Anthropic Claude",
    blurb: "Cloud. Needs an API key.",
    local: false,
    modelKey: "claudeModel",
    secretKey: "claudeSecretId",
    keyRequired: true,
  },
  {
    id: "gemini",
    name: "Google Gemini",
    blurb: "Cloud. Needs an API key.",
    local: false,
    modelKey: "geminiModel",
    secretKey: "geminiSecretId",
    keyRequired: true,
  },
  {
    id: "openai",
    name: "OpenAI",
    blurb: "Cloud. Needs an API key.",
    local: false,
    modelKey: "openaiModel",
    secretKey: "openaiSecretId",
    keyRequired: true,
  },
  {
    id: "groq",
    name: "Groq",
    blurb: "Cloud. Needs an API key.",
    local: false,
    modelKey: "groqModel",
    secretKey: "groqSecretId",
    keyRequired: true,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    blurb: "Cloud. Needs an API key.",
    local: false,
    modelKey: "openRouterModel",
    secretKey: "openRouterSecretId",
    keyRequired: true,
  },
  {
    id: "mistral",
    name: "Mistral AI",
    blurb: "Cloud. Needs an API key.",
    local: false,
    modelKey: "mistralModel",
    secretKey: "mistralSecretId",
    keyRequired: true,
  },
  {
    id: "custom",
    name: "OpenAI-compatible server",
    blurb: "Any server or router with OpenAI's API: LiteLLM, vLLM, Open WebUI and others.",
    local: false,
    modelKey: "customModel",
    urlKey: "customUrl",
    urlPlaceholder: "http://localhost:4000/v1",
    secretKey: "customSecretId",
    keyRequired: false,
    privateKey: "customIsLocal",
  },
];

export function providerInfo(id: AiProvider): ProviderInfo {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[1];
}

export function isLocalProvider(id: string): id is LocalProviderId {
  return isLocalServer(id);
}

export function isAiProvider(id: string): id is AiProvider {
  return PROVIDERS.some((p) => p.id === id);
}

/**
 * Dropdown options for a provider picker: local ones first, then cloud ones
 * when allowed. The OpenAI-compatible server is offered with the local ones
 * once the user says it is theirs (pass the settings to know).
 */
export function providerOptions(includeCloud = true, s?: HormeSettings): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of PROVIDERS) {
    const mine = p.id === "custom" && s !== undefined && keepsNotesPrivate(s, p.id);
    if (!p.local && !includeCloud && !mine) continue;
    out[p.id] = p.id === "custom" ? p.name : p.local ? `${p.name} (local)` : `${p.name} (cloud)`;
  }
  return out;
}

/** The model a provider uses for chat, as saved in settings. */
export function providerModel(s: HormeSettings, id: AiProvider): string {
  return String(s[providerInfo(id).modelKey] ?? "").trim();
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
  if (s.customIsLocal) out.custom = "OpenAI-compatible server";
  else if (s.embeddingSource === "custom") out.custom = "OpenAI-compatible server (paused)";
  return out;
}

/** Where the chosen embedding server lives. */
export function embeddingAddress(s: HormeSettings): string {
  const p = s.embeddingSource;
  if (p === "llamacpp") return s.llamaCppEmbeddingUrl.trim();
  if (p === "lmstudio") return s.lmStudioUrl.trim();
  if (p === "custom") return s.customUrl.trim();
  return s.ollamaBaseUrl.trim();
}

export type ModelPurpose = "chat" | "embedding" | "any";

/**
 * Models in a provider's own list that cannot chat: embeddings, speech, images,
 * moderation and safety classifiers, OCR, and OpenAI's old completion models.
 */
const NOT_CHAT =
  /embed|whisper|tts|dall-e|image|moderation|transcri|realtime|audio|sora|ocr|babbage|davinci|guard|orpheus/i;

function filterByPurpose(ids: string[], purpose: ModelPurpose): string[] {
  if (purpose === "chat") return ids.filter((m) => !NOT_CHAT.test(m));
  if (purpose === "embedding") return ids.filter((m) => /embed|bge|minilm|e5-|gte-/i.test(m));
  return ids;
}

async function getJson(url: string, headers?: Record<string, string>): Promise<unknown> {
  // requestUrl (Obsidian's network layer) rather than fetch: local servers send
  // no CORS allowance for the app://obsidian.md origin.
  const res = await requestUrl({ url, headers, throw: false });
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
  return res.json as unknown;
}

async function listOpenAiCompatible(baseUrl: string, headers?: Record<string, string>): Promise<string[]> {
  const json = await getJson(`${normalizeBaseUrl(baseUrl)}/v1/models`, headers);
  const data = asArray(getRecordProp(json, "data")) ?? [];
  return data.map((m) => getStringProp(m, "id") ?? getStringProp(m, "name")).filter((m): m is string => !!m);
}

async function listOllama(baseUrl: string, headers?: Record<string, string>): Promise<string[]> {
  const json = await getJson(`${normalizeBaseUrl(baseUrl)}/api/tags`, headers);
  const models = asArray(getRecordProp(json, "models")) ?? [];
  return models.map((m) => getStringProp(m, "name")).filter((m): m is string => !!m);
}

async function listCloud(plugin: HormePlugin, id: CloudProviderId): Promise<string[]> {
  const key = plugin.getApiKeyForProvider(id);
  if (!key) throw new Error("no API key");
  switch (id) {
    case "openai":
      return listOpenAiCompatible("https://api.openai.com", { Authorization: `Bearer ${key}` });
    case "groq":
      return listOpenAiCompatible("https://api.groq.com/openai", { Authorization: `Bearer ${key}` });
    case "mistral":
      return listOpenAiCompatible("https://api.mistral.ai", { Authorization: `Bearer ${key}` });
    case "openrouter":
      return listOpenAiCompatible("https://openrouter.ai/api", { Authorization: `Bearer ${key}` });
    case "claude": {
      const json = await getJson("https://api.anthropic.com/v1/models?limit=100", {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      });
      const data = asArray(getRecordProp(json, "data")) ?? [];
      return data.map((m) => getStringProp(m, "id")).filter((m): m is string => !!m);
    }
    case "gemini": {
      const json = await getJson("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", {
        "x-goog-api-key": key,
      });
      const models = asArray(getRecordProp(json, "models")) ?? [];
      return models
        .filter((m) => {
          const methods = asArray(getRecordProp(m, "supportedGenerationMethods")) ?? [];
          return methods.includes("generateContent");
        })
        .map((m) => getStringProp(m, "name")?.replace(/^models\//, ""))
        .filter((m): m is string => !!m);
    }
  }
}

export interface ModelListResult {
  models: string[];
  /** Plain-English line on where the list came from, or why it could not be fetched. */
  note: string;
  ok: boolean;
}

/** Lists an OpenAI-compatible server's models: its base address keeps its version, so /models follows it. */
async function listCompatible(plugin: HormePlugin): Promise<string[]> {
  const base = compatBaseUrl(plugin.settings.customUrl);
  if (!base) throw new Error("no address");
  const json = await getJson(`${base}/models`, bearer(plugin.getApiKeyForProvider("custom")));
  const data = asArray(getRecordProp(json, "data")) ?? [];
  return data.map((m) => getStringProp(m, "id") ?? getStringProp(m, "name")).filter((m): m is string => !!m);
}

/** Where a local provider's server, or the OpenAI-compatible server, lives, for messages. */
function serverLabel(s: HormeSettings, id: LocalProviderId | "custom", purpose: ModelPurpose): string {
  if (id === "custom") return s.customUrl.trim() || "no address yet";
  if (id === "llamacpp") return purpose === "embedding" ? s.llamaCppEmbeddingUrl : s.llamaCppUrl;
  if (id === "lmstudio") return s.lmStudioUrl;
  return s.ollamaBaseUrl;
}

/**
 * Lists the models a provider offers. Never throws: on failure it returns the
 * static suggestions (cloud) or nothing (local), with a note saying why.
 */
export async function listModels(
  plugin: HormePlugin,
  id: AiProvider,
  purpose: ModelPurpose,
): Promise<ModelListResult> {
  const s = plugin.settings;
  const name = providerInfo(id).name;
  try {
    let ids: string[];
    if (id === "ollama") ids = await listOllama(s.ollamaBaseUrl, plugin.serverAuth("ollama"));
    else if (id === "lmstudio")
      ids = await listOpenAiCompatible(s.lmStudioUrl, plugin.serverAuth("lmstudio"));
    else if (id === "llamacpp")
      ids = await listOpenAiCompatible(
        purpose === "embedding" ? s.llamaCppEmbeddingUrl : s.llamaCppUrl,
        plugin.serverAuth("llamacpp", purpose === "embedding" ? "embedding" : "chat"),
      );
    else if (id === "custom") ids = await listCompatible(plugin);
    else ids = await listCloud(plugin, id);
    const models = filterByPurpose(ids, purpose);
    const all = models.length > 0 ? models : ids;
    const what = purpose === "embedding" ? "embedding model" : "model";
    return {
      models: all,
      ok: true,
      note:
        all.length === 0
          ? `${name} answered, but lists no ${what}s.`
          : `${all.length} ${what}${all.length === 1 ? "" : "s"} found on ${name}.`,
    };
  } catch (e: unknown) {
    if (isLocalProvider(id) || id === "custom") {
      const refused = e instanceof Error && /HTTP 40[13]/.test(e.message);
      return {
        models: [],
        ok: false,
        note: refused
          ? `${name} at ${serverLabel(s, id, purpose)} refused the API key. You can still type a model name.`
          : `Could not reach ${name} at ${serverLabel(s, id, purpose)}. You can still type a model name.`,
      };
    }
    const fallback = PROVIDER_MODELS[id] ?? [];
    const why =
      e instanceof Error && e.message === "no API key" ? "Add an API key to list" : "Could not list";
    return {
      models: fallback,
      ok: false,
      note: `${why} ${name}'s models; showing common ones. Any model ID can be typed.`,
    };
  }
}
