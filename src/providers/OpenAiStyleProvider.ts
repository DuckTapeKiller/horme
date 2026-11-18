import type { AiProvider } from "./AiProvider";
import type { NativeTool } from "../skills/types";
import type { OpenAiApi } from "./registry";
import { completeChat, streamChat, type ApiMessage } from "./openAiChat";
import { bearer } from "../utils/providerAccess";
import { isOpenAiReasoningModel, splitSystemMessages } from "../utils/messageRoles";
import { streamOpenAiCompatible } from "../utils/localStream";

export interface OpenAiStyleConfig extends OpenAiApi {
  /** The provider's name, for error messages. */
  label: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
  /** A cloud service, which refuses requests without a key. */
  keyRequired: boolean;
  /**
   * A server the user points Horme at (the OpenAI-compatible server): it
   * needs an address and a model, and it streams through the CORS-proof route,
   * as such a server will not know Obsidian's app:// origin.
   */
  userServer?: boolean;
}

/**
 * A client for any service that speaks OpenAI's chat completions API: OpenAI,
 * Groq, OpenRouter, Mistral and the OpenAI-compatible server. Only the
 * standard request fields are sent, so strict servers accept them; each
 * service's quirks come from its entry in the registry.
 */
export class OpenAiStyleProvider implements AiProvider {
  constructor(private readonly config: OpenAiStyleConfig) {}

  private get url(): string {
    return `${this.config.base}/chat/completions`;
  }

  private headers(): Record<string, string> {
    return { ...bearer(this.config.apiKey), ...this.config.headers };
  }

  private check(model: string): void {
    const { label } = this.config;
    if (this.config.keyRequired && !this.config.apiKey) throw new Error(`No ${label} API Key`);
    if (!this.config.userServer) return;
    if (!this.config.base) throw new Error(`No server address for the ${label}. Add it on the Models page.`);
    if (!model.trim()) throw new Error(`No model chosen for the ${label}.`);
  }

  /**
   * OpenAI's reasoning models, called directly or through a router, refuse
   * max_tokens and any temperature but the default.
   */
  private limits(model: string): Record<string, number> {
    const bare = model.replace(/^.*\//, "");
    if (this.config.reasoningLimits && isOpenAiReasoningModel(bare))
      return { max_completion_tokens: this.config.maxTokens };
    return { temperature: this.config.temperature, max_tokens: this.config.maxTokens };
  }

  /** Services that take one system message only get it first; later ones go in as user turns. */
  private messages(msgs: ApiMessage[]): ApiMessage[] {
    if (!this.config.systemFirst) return msgs;
    const { system, turns } = splitSystemMessages(msgs);
    return system ? [{ role: "system", content: system }, ...turns] : turns;
  }

  generate(prompt: string, system: string, model: string): Promise<string> {
    return this.generateChat(
      [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      model,
    );
  }

  async generateChat(msgs: ApiMessage[], model: string): Promise<string> {
    this.check(model);
    return await completeChat(
      this.url,
      this.headers(),
      { model, messages: this.messages(msgs), ...this.limits(model) },
      this.config.label,
    );
  }

  async stream(
    msgs: ApiMessage[],
    model: string,
    signal?: AbortSignal,
    /** Native tools, for servers that take them (the gateway decides). */
    tools?: NativeTool[],
  ): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    this.check(model);
    const body: Record<string, unknown> = {
      model,
      messages: this.messages(msgs),
      ...this.limits(model),
      stream: true,
    };
    if (tools && tools.length) body.tools = tools;
    return this.config.userServer
      ? await streamOpenAiCompatible(this.url, body, signal, this.headers())
      : await streamChat(this.url, this.headers(), body, signal, this.config.label);
  }
}
