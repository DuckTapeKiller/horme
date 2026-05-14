import { requestUrl } from "obsidian";
import { AiProvider } from "./AiProvider";
import { asArray, getRecordProp, getStringProp } from "../utils/TypeGuards";

export class GeminiProvider implements AiProvider {
  private apiKey: string;
  private temperature: number;
  private maxTokens: number;

  constructor(apiKey: string, temperature: number, maxTokens: number) {
    this.apiKey = apiKey;
    this.temperature = temperature;
    this.maxTokens = maxTokens;
  }

  private extractContent(json: unknown): string {
    const candidates = asArray(getRecordProp(json, "candidates")) ?? [];
    const first = candidates[0];
    const content = getRecordProp(first, "content");
    const parts = asArray(getRecordProp(content, "parts")) ?? [];
    const firstPart = parts[0];
    return getStringProp(firstPart, "text") ?? "";
  }

  async generate(prompt: string, system: string, model: string): Promise<string> {
    if (!this.apiKey) throw new Error("No Gemini API Key");
    const res = await requestUrl({
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: (system ? system + "\n\n" : "") + prompt }] }],
        generationConfig: { temperature: this.temperature, maxOutputTokens: this.maxTokens }
      }),
      throw: false,
    });
    if (res.status !== 200) throw new Error(`Gemini error: ${res.status}`);
    return this.extractContent(res.json as unknown);
  }

  async generateChat(msgs: Array<{ role: string; content: string }>, model: string): Promise<string> {
    if (!this.apiKey) throw new Error("No Gemini API Key");
    const system = msgs.find(m => m.role === "system")?.content;
    const history = msgs.filter(m => m.role !== "system").map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }]
    }));
    const res = await requestUrl({
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify({
        system_instruction: system ? { parts: [{ text: system }] } : undefined,
        contents: history,
        generationConfig: { temperature: this.temperature, maxOutputTokens: this.maxTokens }
      }),
      throw: false,
    });
    if (res.status !== 200) throw new Error(`Gemini error: ${res.status}`);
    return this.extractContent(res.json as unknown);
  }
  async stream(msgs: Array<{ role: string; content: string }>, model: string, signal?: AbortSignal): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    if (!this.apiKey) throw new Error("No Gemini API Key");
    const system = msgs.find(m => m.role === "system")?.content;
    const history = msgs.filter(m => m.role !== "system").map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify({
          system_instruction: system ? { parts: [{ text: system }] } : undefined,
          contents: history,
          generationConfig: { temperature: this.temperature, maxOutputTokens: this.maxTokens },
        }),
        signal,
      }
    );
    if (!res.ok) throw new Error(`Gemini stream error: ${res.status}`);
    if (!res.body) throw new Error("Gemini: no response body");
    return res.body.getReader();
  }
}
