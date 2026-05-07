import { HormeSettings } from "../types";
import { AiProvider } from "./AiProvider";
import { OllamaProvider } from "./OllamaProvider";
import { LmStudioProvider } from "./LmStudioProvider";
import { ClaudeProvider } from "./ClaudeProvider";
import { GeminiProvider } from "./GeminiProvider";
import { OpenAIProvider } from "./OpenAIProvider";
import { GroqProvider } from "./GroqProvider";
import { OpenRouterProvider } from "./OpenRouterProvider";

export class AiGateway {
  private settings: HormeSettings;

  constructor(settings: HormeSettings) {
    this.settings = settings;
  }

  private getProvider(): AiProvider {
    const provider = this.settings.aiProvider;
    switch (provider) {
      case "claude": return new ClaudeProvider(this.settings.claudeApiKey, this.settings.temperature);
      case "gemini": return new GeminiProvider(this.settings.geminiApiKey, this.settings.temperature);
      case "openai": return new OpenAIProvider(this.settings.openaiApiKey, this.settings.temperature);
      case "groq": return new GroqProvider(this.settings.groqApiKey, this.settings.temperature);
      case "openrouter": return new OpenRouterProvider(this.settings.openRouterApiKey, this.settings.temperature);
      case "lmstudio": return new LmStudioProvider(this.settings.lmStudioUrl, this.settings.temperature);
      default: return new OllamaProvider(this.settings.ollamaBaseUrl, this.settings.temperature);
    }
  }

  async generate(prompt: string, system: string, modelOverride?: string): Promise<string> {
    const provider = this.getProvider();
    const model = modelOverride || this.getCurrentModel();
    return await provider.generate(prompt, system, model);
  }

  async stream(msgs: Array<{ role: string; content: string }>, modelOverride?: string, signal?: AbortSignal): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    const provider = this.getProvider();
    const model = modelOverride || this.getCurrentModel();
    return await provider.stream(msgs, model, signal);
  }

  private getCurrentModel(): string {
    const p = this.settings.aiProvider;
    if (p === "claude") return this.settings.claudeModel;
    if (p === "gemini") return this.settings.geminiModel;
    if (p === "openai") return this.settings.openaiModel;
    if (p === "groq") return this.settings.groqModel;
    if (p === "openrouter") return this.settings.openRouterModel;
    if (p === "lmstudio") return this.settings.lmStudioModel;
    return this.settings.defaultModel;
  }
}
