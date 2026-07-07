import { requestUrl } from "obsidian";
import { AiProvider } from "./AiProvider";
import { getRecordProp, getStringProp } from "../utils/TypeGuards";
import { fetchError, requestUrlError } from "../utils/apiError";
import { normalizeBaseUrl } from "../utils/normalizeBaseUrl";
import { NativeTool } from "../skills/types";

export class OllamaProvider implements AiProvider {
  private baseUrl: string;
  private temperature: number;
  private maxTokens: number;

  constructor(baseUrl: string, temperature: number, maxTokens: number) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.temperature = temperature;
    this.maxTokens = maxTokens;
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
        options: { temperature: this.temperature, num_predict: this.maxTokens },
      }),
      throw: false,
    });

    if (response.status !== 200) throw new Error(`Ollama error: ${requestUrlError(response)}`);
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
      throw: false,
    });

    if (response.status !== 200) throw new Error(`Ollama error: ${requestUrlError(response)}`);
    const data: unknown = response.json;
    const error = getStringProp(data, "error");
    const message = getRecordProp(data, "message");
    const content = getStringProp(message, "content") ?? "";
    if (!content && error) throw new Error(`Ollama: ${error}`);
    return content;
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
      stream: true,
      options: { temperature: this.temperature },
    };
    // Ollama's /api/chat native tools API (tool-trained models emit
    // structured message.tool_calls instead of prompt-taught XML).
    if (tools && tools.length) body.tools = tools;
    const res = await window.fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error(`Ollama stream error: ${await fetchError(res)}`);
    if (!res.body) throw new Error("Ollama: no response body");
    return res.body.getReader();
  }
}
