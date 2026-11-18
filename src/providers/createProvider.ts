import type { AiProvider } from "./AiProvider";
import type { AiProvider as AiProviderId, HormeSettings } from "../types";
import { providerInfo } from "./registry";
import { OllamaProvider } from "./OllamaProvider";
import { LmStudioProvider } from "./LmStudioProvider";
import { LlamaCppProvider } from "./LlamaCppProvider";
import { ClaudeProvider } from "./ClaudeProvider";
import { GeminiProvider } from "./GeminiProvider";
import { OpenAiStyleProvider } from "./OpenAiStyleProvider";
import { compatBaseUrl } from "../utils/providerAccess";
import { AppleProvider } from "./AppleProvider";
import type { AppleModelServer } from "../services/AppleModelServer";

/** What a provider needs from the plugin: the settings and the keychain. */
export interface ProviderSource {
  settings: HormeSettings;
  /** The provider's API key from Obsidian's keychain; "" when it has none. */
  getApiKeyForProvider(p: AiProviderId): string;
  /** Shows and logs something the user should know about a reply (a request the server cut). */
  providerWarning?(source: string, message: string): void;
  /** Apple's model server on this Mac, for Apple Intelligence. */
  appleServer?: AppleModelServer;
}

/**
 * The one place a provider is built from the settings, so the chat, the
 * one-shot jobs and tag translation all reach a server the same way, key
 * included. Cloud services that speak OpenAI's API are described in the
 * registry and share one client. An unknown id falls back to Ollama, as it
 * always has.
 */
export function createProvider(
  src: ProviderSource,
  id: AiProviderId,
  maxTokens: number = src.settings.maxTokens,
): AiProvider {
  const s = src.settings;
  const key = src.getApiKeyForProvider(id);
  const info = providerInfo(id);
  if (info.api)
    return new OpenAiStyleProvider({
      ...info.api,
      label: info.name,
      apiKey: key,
      temperature: s.temperature,
      maxTokens,
      keyRequired: true,
    });
  switch (id) {
    case "claude":
      return new ClaudeProvider(key, s.temperature, maxTokens);
    case "gemini":
      return new GeminiProvider(key, s.temperature, maxTokens);
    case "apple":
      if (!src.appleServer) throw new Error("Apple Intelligence is only available in Obsidian on a Mac.");
      return new AppleProvider(src.appleServer, s.temperature, maxTokens);
    case "custom":
      return new OpenAiStyleProvider({
        base: compatBaseUrl(s.customUrl),
        label: info.name,
        apiKey: key,
        temperature: s.temperature,
        maxTokens,
        keyRequired: false,
        reasoningLimits: true,
        userServer: true,
      });
    case "lmstudio":
      return new LmStudioProvider(s.lmStudioUrl, s.temperature, maxTokens, key);
    case "llamacpp":
      return new LlamaCppProvider(s.llamaCppUrl, s.temperature, maxTokens, key);
    default:
      return new OllamaProvider(
        s.ollamaBaseUrl,
        s.temperature,
        maxTokens,
        src.getApiKeyForProvider("ollama"),
        (message) => src.providerWarning?.("Ollama", message),
        s.ollamaContextLength,
      );
  }
}
