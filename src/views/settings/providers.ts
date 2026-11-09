import { requestUrl } from "obsidian";
import type HormePlugin from "../../../main";
import { PROVIDER_MODELS } from "../../constants";
import type { AiProvider, HormeSettings } from "../../types";
import { asArray, getRecordProp, getStringProp } from "../../utils/TypeGuards";
import { normalizeBaseUrl } from "../../utils/normalizeBaseUrl";
import type { StringKey } from "./types";

export type LocalProviderId = "llamacpp" | "ollama" | "lmstudio";
export type CloudProviderId = Exclude<AiProvider, LocalProviderId>;

export interface ProviderInfo {
  id: AiProvider;
  name: string;
  /** Short line shown under the provider's name. */
  blurb: string;
  local: boolean;
  modelKey: StringKey;
  urlKey?: StringKey;
  secretKey?: StringKey;
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: "llamacpp",
    name: "llama.cpp",
    blurb: "Runs on this computer through llama-server.",
    local: true,
    modelKey: "llamaCppModel",
    urlKey: "llamaCppUrl",
  },
  {
    id: "ollama",
    name: "Ollama",
    blurb: "Runs on this computer through Ollama.",
    local: true,
    modelKey: "defaultModel",
    urlKey: "ollamaBaseUrl",
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    blurb: "Runs on this computer through LM Studio's server.",
    local: true,
    modelKey: "lmStudioModel",
    urlKey: "lmStudioUrl",
  },
  {
    id: "claude",
    name: "Anthropic Claude",
    blurb: "Cloud. Needs an API key.",
    local: false,
    modelKey: "claudeModel",
    secretKey: "claudeSecretId",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    blurb: "Cloud. Needs an API key.",
    local: false,
    modelKey: "geminiModel",
    secretKey: "geminiSecretId",
  },
  {
    id: "openai",
    name: "OpenAI",
    blurb: "Cloud. Needs an API key.",
    local: false,
    modelKey: "openaiModel",
    secretKey: "openaiSecretId",
  },
  {
    id: "groq",
    name: "Groq",
    blurb: "Cloud. Needs an API key.",
    local: false,
    modelKey: "groqModel",
    secretKey: "groqSecretId",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    blurb: "Cloud. Needs an API key.",
    local: false,
    modelKey: "openRouterModel",
    secretKey: "openRouterSecretId",
  },
  {
    id: "mistral",
    name: "Mistral AI",
    blurb: "Cloud. Needs an API key.",
    local: false,
    modelKey: "mistralModel",
    secretKey: "mistralSecretId",
  },
];

export function providerInfo(id: AiProvider): ProviderInfo {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[1];
}

export function isLocalProvider(id: string): id is LocalProviderId {
  return id === "llamacpp" || id === "ollama" || id === "lmstudio";
}

export function isAiProvider(id: string): id is AiProvider {
  return PROVIDERS.some((p) => p.id === id);
}

/** Dropdown options for a provider picker: local ones first, then cloud ones when allowed. */
export function providerOptions(includeCloud = true): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of PROVIDERS) {
    if (!p.local && !includeCloud) continue;
    out[p.id] = p.local ? `${p.name} (local)` : `${p.name} (cloud)`;
  }
  return out;
}

/** The model a provider uses for chat, as saved in settings. */
export function providerModel(s: HormeSettings, id: AiProvider): string {
  return String(s[providerInfo(id).modelKey] ?? "").trim();
}

/**
 * Embeddings always come from a local server. The active chat provider is used
 * when it is local; with a cloud chat provider Horme falls back to Ollama.
 */
export function embeddingProvider(s: HormeSettings): LocalProviderId {
  return isLocalProvider(s.aiProvider) ? s.aiProvider : "ollama";
}

/** Suggestions for cloud providers when the live list cannot be fetched. */
const CLOUD_FALLBACK_MODELS: Record<CloudProviderId, string[]> = {
  claude: [
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
    "claude-fable-5-1",
    "claude-haiku-4-5",
  ],
  gemini: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite"],
  openai: ["gpt-4o-mini", "gpt-4o", "gpt-4.1", "gpt-4.1-mini"],
  groq: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
  openrouter: ["openai/gpt-4o-mini", "google/gemini-2.5-flash", "anthropic/claude-sonnet-4.5"],
  mistral: ["mistral-large-latest", "mistral-medium-latest", "mistral-small-latest", "codestral-latest"],
};

export type ModelPurpose = "chat" | "embedding" | "any";

function filterByPurpose(ids: string[], purpose: ModelPurpose): string[] {
  if (purpose === "chat") return ids.filter((m) => !/embed/i.test(m));
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

async function listOllama(baseUrl: string): Promise<string[]> {
  const json = await getJson(`${normalizeBaseUrl(baseUrl)}/api/tags`);
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

/** Where a local provider's server lives, for messages. */
function serverLabel(s: HormeSettings, id: LocalProviderId, purpose: ModelPurpose): string {
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
    if (id === "ollama") ids = await listOllama(s.ollamaBaseUrl);
    else if (id === "lmstudio") ids = await listOpenAiCompatible(s.lmStudioUrl);
    else if (id === "llamacpp")
      ids = await listOpenAiCompatible(purpose === "embedding" ? s.llamaCppEmbeddingUrl : s.llamaCppUrl);
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
    if (isLocalProvider(id)) {
      return {
        models: [],
        ok: false,
        note: `Could not reach ${name} at ${serverLabel(s, id, purpose)}. You can still type a model name.`,
      };
    }
    const fallback = CLOUD_FALLBACK_MODELS[id] ?? PROVIDER_MODELS[id] ?? [];
    const why =
      e instanceof Error && e.message === "no API key" ? "Add an API key to list" : "Could not list";
    return {
      models: fallback,
      ok: false,
      note: `${why} ${name}'s models; showing common ones. Any model ID can be typed.`,
    };
  }
}
