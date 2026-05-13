import { requestUrl } from "obsidian";
import { AiProvider } from "./AiProvider";
import { createAssistantContentReader } from "./StreamUtils";
import { asArray, getRecordProp, getStringProp } from "../utils/TypeGuards";

export class GroqProvider implements AiProvider {
  private apiKey: string;
  private temperature: number;

  constructor(apiKey: string, temperature: number) {
    this.apiKey = apiKey;
    this.temperature = temperature;
  }

  private extractContent(json: unknown): string {
    const choices = asArray(getRecordProp(json, "choices")) ?? [];
    const first = choices[0];
    const message = getRecordProp(first, "message");
    return getStringProp(message, "content") ?? "";
  }

  async generate(prompt: string, system: string, model: string): Promise<string> {
    if (!this.apiKey) throw new Error("No Groq API Key");
    const res = await requestUrl({
      url: "https://api.groq.com/openai/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt }
        ],
        temperature: this.temperature,
        max_tokens: 2048
      }),
      throw: false,
    });
    if (res.status !== 200) throw new Error(`Groq error: ${res.status}`);
    return this.extractContent(res.json as unknown);
  }

  async generateChat(msgs: Array<{ role: string; content: string }>, model: string): Promise<string> {
    if (!this.apiKey) throw new Error("No Groq API Key");
    const res = await requestUrl({
      url: "https://api.groq.com/openai/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: msgs,
        temperature: this.temperature,
        max_tokens: 2048
      }),
      throw: false,
    });
    if (res.status !== 200) throw new Error(`Groq error: ${res.status}`);
    return this.extractContent(res.json as unknown);
  }
  async stream(msgs: Array<{ role: string; content: string }>, model: string, signal?: AbortSignal): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    const full = await this.generateChat(msgs, model);
    return createAssistantContentReader(full, signal);
  }
}
