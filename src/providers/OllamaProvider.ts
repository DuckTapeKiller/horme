import { requestUrl } from "obsidian";
import { AiProvider } from "./AiProvider";
import { createAssistantContentReader } from "./StreamUtils";
import { getRecordProp, getStringProp } from "../utils/TypeGuards";

export class OllamaProvider implements AiProvider {
  private baseUrl: string;
  private temperature: number;

  constructor(baseUrl: string, temperature: number) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.temperature = temperature;
  }

  async generate(prompt: string, system: string, model: string): Promise<string> {
    const url = `${this.baseUrl}/api/generate`;
    const response = await requestUrl({
      url,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        system,
        stream: false,
        options: { temperature: this.temperature, num_predict: 2048 },
      }),
    });
    
    if (response.status !== 200) throw new Error(`Ollama error: ${response.status}`);
    const data: unknown = response.json;
    const error = getStringProp(data, "error");
    const content = getStringProp(data, "response") ?? "";
    if (!content && error) throw new Error(`Ollama: ${error}`);
    return content;
  }
  
  async generateChat(msgs: Array<{ role: string; content: string }>, model: string): Promise<string> {
    const url = `${this.baseUrl}/api/chat`;
    const response = await requestUrl({
      url,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: msgs,
        stream: false,
        options: { temperature: this.temperature },
      }),
    });

    if (response.status !== 200) throw new Error(`Ollama error: ${response.status}`);
    const data: unknown = response.json;
    const error = getStringProp(data, "error");
    const message = getRecordProp(data, "message");
    const content = getStringProp(message, "content") ?? "";
    if (!content && error) throw new Error(`Ollama: ${error}`);
    return content;
  }

  async stream(msgs: Array<{ role: string; content: string }>, model: string, signal?: AbortSignal): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    const full = await this.generateChat(msgs, model);
    return createAssistantContentReader(full, signal);
  }
}
