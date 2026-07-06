import { requestUrl } from "obsidian";
import { AiProvider } from "./AiProvider";
import { requestUrlError } from "../utils/apiError";
import { asArray, getRecordProp, getStringProp } from "../utils/TypeGuards";
import { normalizeBaseUrl } from "../utils/normalizeBaseUrl";
import { streamOpenAiCompatible } from "../utils/localStream";
import { NativeTool } from "../skills/types";

export class LmStudioProvider implements AiProvider {
  private baseUrl: string;
  private temperature: number;
  private maxTokens: number;

  constructor(baseUrl: string, temperature: number, maxTokens: number) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.temperature = temperature;
    this.maxTokens = maxTokens;
  }

  private extractContent(json: unknown): string {
    const choices = asArray(getRecordProp(json, "choices")) ?? [];
    const first = choices[0];
    const message = getRecordProp(first, "message");
    return getStringProp(message, "content") ?? "";
  }

  async generate(prompt: string, system: string, model: string): Promise<string> {
    const res = await requestUrl({
      url: `${this.baseUrl}/v1/chat/completions`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        temperature: this.temperature,
        max_tokens: this.maxTokens,
        stream: false,
      }),
      throw: false,
    });
    if (res.status !== 200) throw new Error(`LM Studio error: ${requestUrlError(res)}`);
    return this.extractContent(res.json as unknown);
  }

  async generateChat(msgs: Array<{ role: string; content: string }>, model: string): Promise<string> {
    const res = await requestUrl({
      url: `${this.baseUrl}/v1/chat/completions`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: msgs,
        temperature: this.temperature,
        max_tokens: this.maxTokens,
        stream: false,
      }),
      throw: false,
    });
    if (res.status !== 200) throw new Error(`LM Studio error: ${requestUrlError(res)}`);
    return this.extractContent(res.json as unknown);
  }

  async stream(
    msgs: Array<{ role: string; content: string }>,
    model: string,
    signal?: AbortSignal,
    tools?: NativeTool[],
  ): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    const body: Record<string, unknown> = {
      model,
      messages: msgs,
      temperature: this.temperature,
      max_tokens: this.maxTokens,
      stream: true,
    };
    if (tools && tools.length) body.tools = tools;
    // CORS-proof transport chain (LM Studio ships with CORS disabled and
    // Obsidian's origin is app://obsidian.md): Node http → fetch → requestUrl.
    return streamOpenAiCompatible(`${this.baseUrl}/v1/chat/completions`, body, signal);
  }
}
