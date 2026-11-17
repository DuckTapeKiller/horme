import { requestUrl } from "obsidian";
import { AiProvider } from "./AiProvider";
import { requestUrlError } from "../utils/apiError";
import { asArray, getRecordProp, getStringProp } from "../utils/TypeGuards";
import { isOpenAiReasoningModel } from "../utils/messageRoles";
import { streamOpenAiCompatible } from "../utils/localStream";
import { bearer, compatBaseUrl } from "../utils/providerAccess";

/**
 * Any server that speaks OpenAI's chat completions API: routers (LiteLLM,
 * OpenRouter-style gateways), self-hosted servers (vLLM, LocalAI, Open WebUI)
 * and hosted ones (DeepSeek, Together). Only the standard request fields are
 * sent, none of llama.cpp's or LM Studio's extras, which strict servers refuse.
 * Streaming goes through the same CORS-proof route as the local servers, as
 * a server the user runs will not know Obsidian's app:// origin.
 */
export class OpenAiCompatibleProvider implements AiProvider {
  private baseUrl: string;
  private apiKey: string;
  private temperature: number;
  private maxTokens: number;

  constructor(baseUrl: string, apiKey: string, temperature: number, maxTokens: number) {
    this.baseUrl = compatBaseUrl(baseUrl);
    this.apiKey = apiKey;
    this.temperature = temperature;
    this.maxTokens = maxTokens;
  }

  private ready(model: string): void {
    if (!this.baseUrl)
      throw new Error("No server address for the OpenAI-compatible server. Add it on the Models page.");
    if (!model.trim()) throw new Error("No model chosen for the OpenAI-compatible server.");
  }

  /**
   * OpenAI's reasoning models, reached through a router, refuse max_tokens and
   * any temperature but the default; everything else takes the usual pair.
   */
  private limits(model: string): Record<string, number> {
    const bare = model.replace(/^.*\//, "");
    if (isOpenAiReasoningModel(bare)) return { max_completion_tokens: this.maxTokens };
    return { temperature: this.temperature, max_tokens: this.maxTokens };
  }

  private extractContent(json: unknown): string {
    const choices = asArray(getRecordProp(json, "choices")) ?? [];
    const message = getRecordProp(choices[0], "message");
    return getStringProp(message, "content") ?? "";
  }

  async generate(prompt: string, system: string, model: string): Promise<string> {
    return this.generateChat(
      [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      model,
    );
  }

  async generateChat(msgs: Array<{ role: string; content: string }>, model: string): Promise<string> {
    this.ready(model);
    const res = await requestUrl({
      url: `${this.baseUrl}/chat/completions`,
      method: "POST",
      headers: { "Content-Type": "application/json", ...bearer(this.apiKey) },
      body: JSON.stringify({ model, messages: msgs, ...this.limits(model), stream: false }),
      throw: false,
    });
    if (res.status !== 200) throw new Error(`OpenAI-compatible server error: ${requestUrlError(res)}`);
    return this.extractContent(res.json as unknown);
  }

  async stream(
    msgs: Array<{ role: string; content: string }>,
    model: string,
    signal?: AbortSignal,
  ): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    this.ready(model);
    return streamOpenAiCompatible(
      `${this.baseUrl}/chat/completions`,
      { model, messages: msgs, ...this.limits(model), stream: true },
      signal,
      bearer(this.apiKey),
    );
  }
}
