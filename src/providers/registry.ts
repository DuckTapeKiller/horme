import type { AiProvider, BooleanKey, HormeSettings, StringKey } from "../types";
import { isLocalServer } from "../utils/providerAccess";

/**
 * Everything Horme knows about each provider, in one place: its name, the
 * settings that hold its address, key and model, and, for cloud services that
 * speak OpenAI's API, where that API is. Adding a provider starts here.
 */

export type LocalProviderId = "llamacpp" | "ollama" | "lmstudio";
export type CloudProviderId = Exclude<AiProvider, LocalProviderId | "custom">;

export interface ProviderInfo {
  id: AiProvider;
  name: string;
  /** A shorter name for narrow places (the chat's provider button); the name when unset. */
  shortName?: string;
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
  /** Cloud services that speak OpenAI's chat API: where it is, and their quirks. */
  api?: OpenAiApi;
  /**
   * Offered skills as native tools (OpenAI's tool schema) rather than as text
   * instructions: servers on the user's machines whose models take tools.
   */
  nativeTools?: boolean;
}

/** A cloud service that speaks OpenAI's chat completions API. */
export interface OpenAiApi {
  /** The base address: /chat/completions and /models follow it. */
  base: string;
  /** Extra headers the service asks for. */
  headers?: Record<string, string>;
  /** OpenAI's reasoning models take max_completion_tokens and no temperature. */
  reasoningLimits?: boolean;
  /** Only one system message, at the start (Mistral). */
  systemFirst?: boolean;
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
    nativeTools: true,
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
    nativeTools: true,
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
    nativeTools: true,
  },
  {
    id: "apple",
    name: "Apple Intelligence",
    blurb: "Apple's own model, run by macOS on this Mac (macOS 27 or later).",
    local: true,
    modelKey: "appleModel",
    keyRequired: false,
    nativeTools: true,
  },
  {
    id: "claude",
    name: "Anthropic Claude",
    shortName: "Claude",
    blurb: "Cloud. Needs an API key.",
    local: false,
    modelKey: "claudeModel",
    secretKey: "claudeSecretId",
    keyRequired: true,
  },
  {
    id: "gemini",
    name: "Google Gemini",
    shortName: "Gemini",
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
    api: { base: "https://api.openai.com/v1", reasoningLimits: true },
  },
  {
    id: "groq",
    name: "Groq",
    blurb: "Cloud. Needs an API key.",
    local: false,
    modelKey: "groqModel",
    secretKey: "groqSecretId",
    keyRequired: true,
    api: { base: "https://api.groq.com/openai/v1" },
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    blurb: "Cloud. Needs an API key.",
    local: false,
    modelKey: "openRouterModel",
    secretKey: "openRouterSecretId",
    keyRequired: true,
    api: {
      base: "https://openrouter.ai/api/v1",
      headers: { "HTTP-Referer": "https://github.com/DuckTapeKiller/horme", "X-Title": "Horme" },
    },
  },
  {
    id: "mistral",
    name: "Mistral AI",
    shortName: "Mistral",
    blurb: "Cloud. Needs an API key.",
    local: false,
    modelKey: "mistralModel",
    secretKey: "mistralSecretId",
    keyRequired: true,
    api: { base: "https://api.mistral.ai/v1", systemFirst: true },
  },
  {
    id: "custom",
    name: "OpenAI-compatible server",
    shortName: "OpenAI-compatible",
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

export function providerModel(s: HormeSettings, id: AiProvider): string {
  return String(s[providerInfo(id).modelKey] ?? "").trim();
}

/** The keychain name of the provider's API key, as set; "" when it has none. */
export function providerSecretId(s: HormeSettings, id: AiProvider): string {
  const key = providerInfo(id).secretKey;
  return key ? String(s[key] ?? "").trim() : "";
}
