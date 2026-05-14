import HormePlugin from "../../main";
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

  public getProvider(): AiProvider {
    const settings = this.plugin.settings;
    const provider = settings.aiProvider;
    switch (provider) {
      case "claude": return new ClaudeProvider(settings.claudeApiKey, settings.temperature, settings.maxTokens);
      case "gemini": return new GeminiProvider(settings.geminiApiKey, settings.temperature, settings.maxTokens);
      case "openai": return new OpenAIProvider(settings.openaiApiKey, settings.temperature, settings.maxTokens);
      case "groq": return new GroqProvider(settings.groqApiKey, settings.temperature, settings.maxTokens);
      case "openrouter": return new OpenRouterProvider(settings.openRouterApiKey, settings.temperature, settings.maxTokens);
      case "lmstudio": return new LmStudioProvider(settings.lmStudioUrl, settings.temperature, settings.maxTokens);
      default: return new OllamaProvider(settings.ollamaBaseUrl, settings.temperature, settings.maxTokens);
    }
  }

  private getSystemPromptWithSkills(baseSystem: string, suppressVaultSkill = false, suppressAllSkills = false, targetSkillId?: string): string {
    if (suppressAllSkills) return baseSystem;
    const skillInstructions = this.plugin.skillManager.getSkillInstructions(suppressVaultSkill, targetSkillId);
    return `${baseSystem}\n\n${skillInstructions}`;
  }

  async generate(prompt: string | Array<{role: string, content: string}>, system: string, modelOverride?: string, suppressAllSkills = false, targetSkillId?: string): Promise<string> {
    const provider = this.getProvider();
    const model = modelOverride || this.getCurrentModel();
    const enhancedSystem = this.getSystemPromptWithSkills(system, false, suppressAllSkills, targetSkillId);
    
    if (Array.isArray(prompt)) {
      const msgs = [
        { role: "system", content: enhancedSystem },
        ...prompt
      ];
      try {
        return await provider.generateChat(msgs, model);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        this.plugin.diagnosticService.report(`${this.plugin.settings.aiProvider}`, `Generation failed: ${msg}`);
        throw e instanceof Error ? e : new Error(msg);
      }
    }

    try {
      return await provider.generate(prompt, enhancedSystem, model);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.plugin.diagnosticService.report(`${this.plugin.settings.aiProvider}`, `Generation failed: ${msg}`);
      throw e instanceof Error ? e : new Error(msg);
    }
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

    try {
      return await provider.stream(enhancedMsgs, model, signal);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.plugin.diagnosticService.report(`${this.plugin.settings.aiProvider}`, `Streaming failed: ${msg}`);
      throw e instanceof Error ? e : new Error(msg);
    }
  }

  public getCurrentModel(): string {
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

  /**
   * Generates a completion using an explicitly specified provider and model,
   * independent of the current chat provider/model. No skill instructions are
   * injected — this is intended for focused background tasks like tag generation.
   */
  public async generateWith(
    prompt: string,
    system: string,
    providerName: string,
    model: string
  ): Promise<string> {
    const settings = this.plugin.settings;
    let provider: AiProvider;
    switch (providerName) {
      case "claude":
        provider = new ClaudeProvider(settings.claudeApiKey, settings.temperature, settings.maxTokens);
        break;
      case "gemini":
        provider = new GeminiProvider(settings.geminiApiKey, settings.temperature, settings.maxTokens);
        break;
      case "openai":
        provider = new OpenAIProvider(settings.openaiApiKey, settings.temperature, settings.maxTokens);
        break;
      case "groq":
        provider = new GroqProvider(settings.groqApiKey, settings.temperature, settings.maxTokens);
        break;
      case "openrouter":
        provider = new OpenRouterProvider(settings.openRouterApiKey, settings.temperature, settings.maxTokens);
        break;
      case "lmstudio":
        provider = new LmStudioProvider(settings.lmStudioUrl, settings.temperature, settings.maxTokens);
        break;
      default:
        provider = new OllamaProvider(settings.ollamaBaseUrl, settings.temperature, settings.maxTokens);
    }
    try {
      return await provider.generate(prompt, system, model);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.plugin.diagnosticService.report("Tags", `Tag generation failed (model: ${model}): ${msg}`);
      throw e instanceof Error ? e : new Error(msg);
    }
  }
}
