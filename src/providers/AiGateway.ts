import HormePlugin from "../../main";
import { AiProvider, StreamOptions } from "./AiProvider";
import { createProvider } from "./createProvider";
import { AiProvider as AiProviderId } from "../types";
export class AiGateway {
  private plugin: HormePlugin;

  constructor(plugin: HormePlugin) {
    this.plugin = plugin;
  }

  public getProvider(): AiProvider {
    return createProvider(this.plugin, this.plugin.settings.aiProvider);
  }

  private getSystemPromptWithSkills(
    baseSystem: string,
    suppressVaultSkill = false,
    suppressAllSkills = false,
    targetSkillId?: string,
    native = false,
  ): string {
    if (suppressAllSkills) return baseSystem;
    const skillInstructions = this.plugin.skillManager.getSkillInstructions(
      suppressVaultSkill,
      targetSkillId,
      { native },
    );
    return `${baseSystem}\n\n${skillInstructions}`;
  }

  async generate(
    prompt: string | Array<{ role: string; content: string }>,
    system: string,
    modelOverride?: string,
    suppressAllSkills = false,
    targetSkillId?: string,
  ): Promise<string> {
    const provider = this.getProvider();
    const model = modelOverride || this.getCurrentModel();
    const enhancedSystem = this.getSystemPromptWithSkills(system, false, suppressAllSkills, targetSkillId);

    if (Array.isArray(prompt)) {
      const msgs = [{ role: "system", content: enhancedSystem }, ...prompt];
      try {
        return await provider.generateChat(msgs, model);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        this.plugin.diagnosticService.report(
          `${this.plugin.settings.aiProvider}`,
          `Generation failed: ${msg}`,
        );
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

  async stream(
    msgs: Array<{ role: string; content: string }>,
    modelOverride?: string,
    signal?: AbortSignal,
    suppressVaultSkill = false,
    suppressAllSkills = false,
    options?: StreamOptions,
  ): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    const provider = this.getProvider();
    const model = modelOverride || this.getCurrentModel();
    const providerId = this.plugin.settings.aiProvider;

    // Native OpenAI-schema tools for local providers with tool support; the
    // prompt-taught XML syntax stays the fallback for everything else.
    const nativeEligible =
      !suppressAllSkills &&
      this.plugin.settings.nativeToolCalling &&
      (providerId === "lmstudio" || providerId === "ollama" || providerId === "llamacpp");
    const tools = nativeEligible ? this.plugin.skillManager.getNativeTools(suppressVaultSkill) : [];
    const useNative = tools.length > 0;

    // Inject skills into the first system message or add a new one
    const buildEnhancedMsgs = (native: boolean) => {
      const enhancedMsgs = [...msgs];
      const systemIdx = enhancedMsgs.findIndex((m) => m.role === "system");
      if (systemIdx !== -1) {
        enhancedMsgs[systemIdx] = {
          ...enhancedMsgs[systemIdx],
          content: this.getSystemPromptWithSkills(
            enhancedMsgs[systemIdx].content,
            suppressVaultSkill,
            suppressAllSkills,
            undefined,
            native,
          ),
        };
      } else {
        enhancedMsgs.unshift({
          role: "system",
          content: this.getSystemPromptWithSkills(
            "",
            suppressVaultSkill,
            suppressAllSkills,
            undefined,
            native,
          ),
        });
      }
      return enhancedMsgs;
    };

    try {
      return await provider.stream(
        buildEnhancedMsgs(useNative),
        model,
        signal,
        useNative ? tools : undefined,
        options,
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // A server/model without tool support (e.g. Ollama's "model does not
      // support tools") — retry the same request on the XML skill path.
      if (useNative && /tool/i.test(msg)) {
        this.plugin.diagnosticService.report(
          `${this.plugin.settings.aiProvider}`,
          `Native tool calling unavailable (${msg.slice(0, 120)}); falling back to XML skill prompt.`,
          "warning",
        );
        try {
          return await provider.stream(buildEnhancedMsgs(false), model, signal, undefined, options);
        } catch (fallbackError: unknown) {
          const fallbackMsg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          this.plugin.diagnosticService.report(
            `${this.plugin.settings.aiProvider}`,
            `Streaming failed: ${fallbackMsg}`,
          );
          throw fallbackError instanceof Error ? fallbackError : new Error(fallbackMsg);
        }
      }
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
    if (p === "mistral") return settings.mistralModel;
    if (p === "lmstudio") return settings.lmStudioModel;
    if (p === "llamacpp") return settings.llamaCppModel;
    if (p === "custom") return settings.customModel;
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
    model: string,
  ): Promise<string> {
    const provider = createProvider(this.plugin, providerName as AiProviderId);
    try {
      return await provider.generate(prompt, system, model);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.plugin.diagnosticService.report("Tags", `Tag generation failed (model: ${model}): ${msg}`);
      throw e instanceof Error ? e : new Error(msg);
    }
  }
}
