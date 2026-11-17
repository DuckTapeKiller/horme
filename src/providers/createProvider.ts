import type { AiProvider } from "./AiProvider";
import type { AiProvider as AiProviderId, HormeSettings } from "../types";
import { OllamaProvider } from "./OllamaProvider";
import { LmStudioProvider } from "./LmStudioProvider";
import { LlamaCppProvider } from "./LlamaCppProvider";
import { ClaudeProvider } from "./ClaudeProvider";
import { GeminiProvider } from "./GeminiProvider";
import { OpenAIProvider } from "./OpenAIProvider";
import { GroqProvider } from "./GroqProvider";
import { OpenRouterProvider } from "./OpenRouterProvider";
import { MistralProvider } from "./MistralProvider";
import { OpenAiCompatibleProvider } from "./OpenAiCompatibleProvider";

/** What a provider needs from the plugin: the settings and the keychain. */
export interface ProviderSource {
  settings: HormeSettings;
  /** The provider's API key from Obsidian's keychain; "" when it has none. */
  getApiKeyForProvider(p: AiProviderId): string;
  /** Shows and logs something the user should know about a reply (a request the server cut). */
  providerWarning?(source: string, message: string): void;
}

/**
 * The one place a provider is built from the settings, so the chat, the
 * one-shot jobs and tag translation all reach a server the same way, key
 * included. An unknown id falls back to Ollama, as it always has.
 */
export function createProvider(
  src: ProviderSource,
  id: AiProviderId,
  maxTokens: number = src.settings.maxTokens,
): AiProvider {
  const s = src.settings;
  const key = src.getApiKeyForProvider(id);
  switch (id) {
    case "claude":
      return new ClaudeProvider(key, s.temperature, maxTokens);
    case "gemini":
      return new GeminiProvider(key, s.temperature, maxTokens);
    case "openai":
      return new OpenAIProvider(key, s.temperature, maxTokens);
    case "groq":
      return new GroqProvider(key, s.temperature, maxTokens);
    case "openrouter":
      return new OpenRouterProvider(key, s.temperature, maxTokens);
    case "mistral":
      return new MistralProvider(key, s.temperature, maxTokens);
    case "custom":
      return new OpenAiCompatibleProvider(s.customUrl, key, s.temperature, maxTokens);
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
