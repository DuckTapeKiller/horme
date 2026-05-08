import HormePlugin from "../../main";
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
  private plugin: HormePlugin;

  constructor(plugin: HormePlugin) {
    this.plugin = plugin;
  }

  private getProvider(): AiProvider {
    const settings = this.plugin.settings;
    const provider = settings.aiProvider;
    switch (provider) {
      case "claude": return new ClaudeProvider(settings.claudeApiKey, settings.temperature);
      case "gemini": return new GeminiProvider(settings.geminiApiKey, settings.temperature);
      case "openai": return new OpenAIProvider(settings.openaiApiKey, settings.temperature);
      case "groq": return new GroqProvider(settings.groqApiKey, settings.temperature);
      case "openrouter": return new OpenRouterProvider(settings.openRouterApiKey, settings.temperature);
      case "lmstudio": return new LmStudioProvider(settings.lmStudioUrl, settings.temperature);
      default: return new OllamaProvider(settings.ollamaBaseUrl, settings.temperature);
    }
  }

  private getSystemPromptWithSkills(baseSystem: string, suppressVaultSkill = false): string {
    const skillInstructions = this.plugin.skillManager.getSkillInstructions(suppressVaultSkill);
    return `${baseSystem}\n\n${skillInstructions}`;
  }

  async generate(prompt: string | Array<{role: string, content: string}>, system: string, modelOverride?: string): Promise<string> {
    const provider = this.getProvider();
    const model = modelOverride || this.getCurrentModel();
    const enhancedSystem = this.getSystemPromptWithSkills(system);
    
    if (Array.isArray(prompt)) {
      // Use the messages array directly if provided
      const msgs = [
        { role: "system", content: enhancedSystem },
        ...prompt
      ];
      // We'll use a new non-streaming chat helper to ensure compatibility
      return await provider.generateChat(msgs, model);
    }

    return await provider.generate(prompt, enhancedSystem, model);
  }

  async stream(msgs: Array<{ role: string; content: string }>, modelOverride?: string, signal?: AbortSignal, suppressVaultSkill = false): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    const provider = this.getProvider();
    const model = modelOverride || this.getCurrentModel();
    
    // Inject skills into the first system message or add a new one
    const enhancedMsgs = [...msgs];
    const systemIdx = enhancedMsgs.findIndex(m => m.role === "system");
    if (systemIdx !== -1) {
      enhancedMsgs[systemIdx] = { 
        ...enhancedMsgs[systemIdx], 
        content: this.getSystemPromptWithSkills(enhancedMsgs[systemIdx].content, suppressVaultSkill) 
      };
    } else {
      enhancedMsgs.unshift({ role: "system", content: this.getSystemPromptWithSkills("", suppressVaultSkill) });
    }

    return await provider.stream(enhancedMsgs, model, signal);
  }

  private getCurrentModel(): string {
    const p = this.plugin.settings.aiProvider;
    const settings = this.plugin.settings;
    if (p === "claude") return settings.claudeModel;
    if (p === "gemini") return settings.geminiModel;
    if (p === "openai") return settings.openaiModel;
    if (p === "groq") return settings.groqModel;
    if (p === "openrouter") return settings.openRouterModel;
    if (p === "lmstudio") return settings.lmStudioModel;
    return settings.defaultModel;
  }
}
