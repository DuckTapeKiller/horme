import { requestUrl } from "obsidian";
import { AiProvider } from "./AiProvider";
import { asArray, getRecordProp, getStringProp } from "../utils/TypeGuards";

export class OpenRouterProvider implements AiProvider {
  private apiKey: string;
  private temperature: number;
  private maxTokens: number;

  constructor(apiKey: string, temperature: number, maxTokens: number) {
    this.apiKey = apiKey;
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
    if (!this.apiKey) throw new Error("No OpenRouter API Key");
    const res = await requestUrl({
      url: "https://openrouter.ai/api/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
        "HTTP-Referer": "https://github.com/DuckTapeKiller/horme",
        "X-Title": "Horme"
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt }
        ],
        temperature: this.temperature,
        max_tokens: this.maxTokens
      }),
      throw: false,
    });
    if (res.status !== 200) throw new Error(`OpenRouter error: ${res.status}`);
    return this.extractContent(res.json as unknown);
  }

  async generateChat(msgs: Array<{ role: string; content: string }>, model: string): Promise<string> {
    if (!this.apiKey) throw new Error("No OpenRouter API Key");
    const res = await requestUrl({
      url: "https://openrouter.ai/api/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
        "HTTP-Referer": "https://github.com/DuckTapeKiller/horme",
        "X-Title": "Horme"
      },
      body: JSON.stringify({
        model,
        messages: msgs,
        temperature: this.temperature,
        max_tokens: this.maxTokens
      }),
      throw: false,
    });
    if (res.status !== 200) throw new Error(`OpenRouter error: ${res.status}`);
    return this.extractContent(res.json as unknown);
  }
  async stream(msgs: Array<{ role: string; content: string }>, model: string, signal?: AbortSignal): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    if (!this.apiKey) throw new Error("No OpenRouter API Key");
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
        "HTTP-Referer": "https://github.com/DuckTapeKiller/horme",
        "X-Title": "Horme",
      },
      body: JSON.stringify({
        model,
        messages: msgs,
        temperature: this.temperature,
        max_tokens: this.maxTokens,
        stream: true,
      }),
      signal,
    });
    if (!res.ok) throw new Error(`OpenRouter stream error: ${res.status}`);
    if (!res.body) throw new Error("OpenRouter: no response body");
    return res.body.getReader();
  }
}
