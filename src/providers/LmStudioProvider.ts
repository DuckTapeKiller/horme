import { requestUrl } from "obsidian";
import { AiProvider } from "./AiProvider";
import { createAssistantContentReader } from "./StreamUtils";
import { asArray, getRecordProp, getStringProp } from "../utils/TypeGuards";

export class LmStudioProvider implements AiProvider {
  private baseUrl: string;
  private temperature: number;

  constructor(baseUrl: string, temperature: number) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.temperature = temperature;
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
        max_tokens: 2048,
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
        max_tokens: 2048,
        stream: false
      }),
      throw: false,
    });
    if (res.status !== 200) throw new Error(`LM Studio error: ${res.status}`);
    return this.extractContent(res.json as unknown);
  }
  async stream(msgs: Array<{ role: string; content: string }>, model: string, signal?: AbortSignal): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    const full = await this.generateChat(msgs, model);
    return createAssistantContentReader(full, signal);
  }
}
