import { requestUrl } from "obsidian";
import { AiProvider } from "./AiProvider";
import { asArray, getRecordProp, getStringProp } from "../utils/TypeGuards";

export class LmStudioProvider implements AiProvider {
  private baseUrl: string;
  private temperature: number;
  private maxTokens: number;

  constructor(baseUrl: string, temperature: number, maxTokens: number) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
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
          { role: "user", content: prompt }
        ],
        temperature: this.temperature,
        max_tokens: this.maxTokens,
        stream: false
      }),
      throw: false,
    });
    if (res.status !== 200) throw new Error(`LM Studio error: ${res.status}`);
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
        stream: false
      }),
      throw: false,
    });
    if (res.status !== 200) throw new Error(`LM Studio error: ${res.status}`);
    return this.extractContent(res.json as unknown);
  }
  async stream(msgs: Array<{ role: string; content: string }>, model: string, signal?: AbortSignal): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: msgs,
        temperature: this.temperature,
        max_tokens: this.maxTokens,
        stream: true,
      }),
      signal,
    });
    if (!res.ok) throw new Error(`LM Studio stream error: ${res.status}`);
    if (!res.body) throw new Error("LM Studio: no response body");
    return res.body.getReader();
  }
}
