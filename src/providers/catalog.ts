import { requestUrl } from "obsidian";
import type HormePlugin from "../../main";
import { PROVIDER_MODELS } from "../constants";
import type { AiProvider, HormeSettings } from "../types";
import { asArray, getRecordProp, getStringProp } from "../utils/TypeGuards";
import { normalizeBaseUrl } from "../utils/normalizeBaseUrl";
import { bearer, compatBaseUrl } from "../utils/providerAccess";
import type { OllamaModelTag } from "../utils/ollamaModels";
import { isLocalProvider, providerInfo } from "./registry";

/**
 * What each provider offers: its models, and whether it answers at all.
 * Every list and every connection check asks the provider's own model list,
 * described once here.
 */

export type ModelPurpose = "chat" | "embedding" | "any";

export interface ModelListResult {
  models: string[];
  /** Plain-English line on where the list came from, or why it could not be fetched. */
  note: string;
  ok: boolean;
}

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

/** How to ask a provider for its models: where, with which headers, and how to read the answer. */
interface ModelsRequest {
  url: string;
  headers: Record<string, string>;
  read: (json: unknown) => string[];
}

const ids = (json: unknown, listKey: string, ...idKeys: string[]): string[] =>
  (asArray(getRecordProp(json, listKey)) ?? [])
    .map((m) => idKeys.map((k) => getStringProp(m, k)).find(Boolean))
    .filter((m): m is string => !!m);

/** The request that lists a provider's models; throws "no API key" or "no address" when it cannot be made. */
function modelsRequest(plugin: HormePlugin, id: AiProvider, purpose: ModelPurpose): ModelsRequest {
  const s = plugin.settings;
  const openAiList = (json: unknown) => ids(json, "data", "id", "name");
  if (id === "ollama")
    return {
      url: `${normalizeBaseUrl(s.ollamaBaseUrl)}/api/tags`,
      headers: plugin.serverAuth("ollama"),
      read: (json) => ids(json, "models", "name"),
    };
  if (id === "lmstudio")
    return {
      url: `${normalizeBaseUrl(s.lmStudioUrl)}/v1/models`,
      headers: plugin.serverAuth("lmstudio"),
      read: openAiList,
    };
  if (id === "llamacpp") {
    const embedding = purpose === "embedding";
    return {
      url: `${normalizeBaseUrl(embedding ? s.llamaCppEmbeddingUrl : s.llamaCppUrl)}/v1/models`,
      headers: plugin.serverAuth("llamacpp", embedding ? "embedding" : "chat"),
      read: openAiList,
    };
  }
  if (id === "custom") {
    const base = compatBaseUrl(s.customUrl);
    if (!base) throw new Error("no address");
    return {
      url: `${base}/models`,
      headers: bearer(plugin.getApiKeyForProvider("custom")),
      read: openAiList,
    };
  }
  const key = plugin.getApiKeyForProvider(id);
  if (!key) throw new Error("no API key");
  const api = providerInfo(id).api;
  if (api)
    return { url: `${api.base}/models`, headers: { ...bearer(key), ...api.headers }, read: openAiList };
  if (id === "claude")
    return {
      url: "https://api.anthropic.com/v1/models?limit=100",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      read: (json) => ids(json, "data", "id"),
    };
  // Gemini: only models that can write text.
  return {
    url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
    headers: { "x-goog-api-key": key },
    read: (json) =>
      (asArray(getRecordProp(json, "models")) ?? [])
        .filter((m) =>
          (asArray(getRecordProp(m, "supportedGenerationMethods")) ?? []).includes("generateContent"),
        )
        .map((m) => getStringProp(m, "name")?.replace(/^models\//, ""))
        .filter((m): m is string => !!m),
  };
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  // requestUrl (Obsidian's network layer) rather than fetch: local servers send
  // no CORS allowance for the app://obsidian.md origin.
  const res = await requestUrl({ url, headers, throw: false });
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
  return res.json as unknown;
}

/** Where a local provider's server, or the OpenAI-compatible server, lives, for messages. */
function serverLabel(s: HormeSettings, id: AiProvider, purpose: ModelPurpose): string {
  if (id === "custom") return s.customUrl.trim() || "no address yet";
  if (id === "llamacpp") return purpose === "embedding" ? s.llamaCppEmbeddingUrl : s.llamaCppUrl;
  if (id === "lmstudio") return s.lmStudioUrl;
  return s.ollamaBaseUrl;
}

/**
 * Lists the models a provider offers. Never throws: on failure it returns the
 * common models (cloud) or nothing (servers the user runs), with a note saying why.
 */
export async function listModels(
  plugin: HormePlugin,
  id: AiProvider,
  purpose: ModelPurpose,
): Promise<ModelListResult> {
  if (id === "apple") return appleModels(plugin);
  const name = providerInfo(id).name;
  try {
    const req = modelsRequest(plugin, id, purpose);
    const all = req.read(await getJson(req.url, req.headers));
    const fitting = filterByPurpose(all, purpose);
    const models = fitting.length > 0 ? fitting : all;
    const what = purpose === "embedding" ? "embedding model" : "model";
    return {
      models,
      ok: true,
      note:
        models.length === 0
          ? `${name} answered, but lists no ${what}s.`
          : `${models.length} ${what}${models.length === 1 ? "" : "s"} found on ${name}.`,
    };
  } catch (e: unknown) {
    if (isLocalProvider(id) || id === "custom") {
      const refused = e instanceof Error && /HTTP 40[13]/.test(e.message);
      const where = `${name} at ${serverLabel(plugin.settings, id, purpose)}`;
      return {
        models: [],
        ok: false,
        note: refused
          ? `${where} refused the API key. You can still type a model name.`
          : `Could not reach ${where}. You can still type a model name.`,
      };
    }
    const why =
      e instanceof Error && e.message === "no API key" ? "Add an API key to list" : "Could not list";
    return {
      models: PROVIDER_MODELS[id] ?? [],
      ok: false,
      note: `${why} ${name}'s models; showing common ones. Any model ID can be typed.`,
    };
  }
}

/**
 * Apple Intelligence's models, from the server macOS runs for Horme: the ones
 * usable here, and why the others are not (Private Cloud Compute needs an
 * iCloud account; the model needs Apple Intelligence turned on).
 */
async function appleModels(plugin: HormePlugin): Promise<ModelListResult> {
  try {
    const status = await plugin.appleServer.status();
    const models = status.filter((m) => m.available).map((m) => m.name);
    const why = status.filter((m) => !m.available).map((m) => `${m.name}: ${m.reason}`);
    return {
      models,
      ok: models.length > 0,
      note: models.length
        ? `Ready on this Mac: ${models.join(", ")}.${why.length ? ` Not available: ${why.join(" ")}` : ""}`
        : `Apple Intelligence offers no model here. ${why.join(" ")}`,
    };
  } catch (e: unknown) {
    return {
      models: [],
      ok: false,
      note: e instanceof Error ? e.message : "Apple Intelligence did not start.",
    };
  }
}

/** True when the chat provider answers its model list: reachable, and the key (if any) accepted. */
export async function checkConnection(plugin: HormePlugin): Promise<boolean> {
  if (plugin.settings.aiProvider === "apple") {
    try {
      const model = plugin.settings.appleModel.trim() || "system";
      return (await plugin.appleServer.status()).some((m) => m.name === model && m.available);
    } catch {
      return false;
    }
  }
  try {
    const req = modelsRequest(plugin, plugin.settings.aiProvider, "chat");
    const res = await requestUrl({ url: req.url, headers: req.headers, throw: false });
    return res.status === 200;
  } catch {
    return false; // no key, no address, or no answer
  }
}

/** Ollama's models with their family and age, for picking a chat model; [] when Ollama does not answer. */
export async function ollamaModelTags(plugin: HormePlugin): Promise<OllamaModelTag[]> {
  try {
    const req = modelsRequest(plugin, "ollama", "any");
    const json = await getJson(req.url, req.headers);
    return (asArray(getRecordProp(json, "models")) ?? []).flatMap((m) => {
      const name = getStringProp(m, "name");
      if (!name) return [];
      const family = getStringProp(getRecordProp(m, "details"), "family");
      return [
        { name, modified_at: getStringProp(m, "modified_at"), details: family ? { family } : undefined },
      ];
    });
  } catch {
    return [];
  }
}
