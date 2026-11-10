import { requestUrl } from "obsidian";
import { AiProvider } from "./AiProvider";
import { fetchError, requestUrlError } from "../utils/apiError";
import { asArray, getRecordProp, getStringProp } from "../utils/TypeGuards";
import { claudeAcceptsTemperature, splitSystemMessages } from "../utils/messageRoles";

type ClaudeMessage = { role: "user" | "assistant"; content: string };

export class ClaudeProvider implements AiProvider {
  private apiKey: string;
  private temperature: number;
  private maxTokens: number;

  constructor(apiKey: string, temperature: number, maxTokens: number) {
    this.apiKey = apiKey;
    this.temperature = temperature;
    this.maxTokens = maxTokens;
  }

  private extractText(json: unknown): string {
    const contentArr = asArray(getRecordProp(json, "content")) ?? [];
    const texts: string[] = [];
    for (const block of contentArr) {
      const text = getStringProp(block, "text");
      if (text) texts.push(text);
    }
    return texts.join("");
  }

  private normalizeMsgs(msgs: Array<{ role: string; content: string }>): {
    system: string;
    history: ClaudeMessage[];
  } {
    const { system, turns } = splitSystemMessages(msgs);
    return { system, history: turns };
  }

  /** Body fields shared by every request. */
  private baseBody(model: string, system: string): Record<string, unknown> {
    const body: Record<string, unknown> = { model, max_tokens: this.maxTokens, system };
    if (claudeAcceptsTemperature(model)) body.temperature = this.temperature;
    return body;
  }

  async generate(prompt: string, system: string, model: string): Promise<string> {
    if (!this.apiKey) throw new Error("No Claude API Key");
    const res = await requestUrl({
      url: "https://api.anthropic.com/v1/messages",
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...this.baseBody(model, system),
        messages: [{ role: "user", content: prompt }],
      }),
      throw: false,
    });

    if (res.status !== 200) throw new Error(`Claude error: ${requestUrlError(res)}`);
    return this.extractText(res.json as unknown);
  }

  async generateChat(msgs: Array<{ role: string; content: string }>, model: string): Promise<string> {
    if (!this.apiKey) throw new Error("No Claude API Key");

    const { system, history } = this.normalizeMsgs(msgs);
    const res = await requestUrl({
      url: "https://api.anthropic.com/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        ...this.baseBody(model, system),
        messages: history,
      }),
      throw: false,
    });

    if (res.status !== 200) throw new Error(`Claude error: ${requestUrlError(res)}`);
    return this.extractText(res.json as unknown);
  }

  async stream(
    msgs: Array<{ role: string; content: string }>,
    model: string,
    signal?: AbortSignal,
  ): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    if (!this.apiKey) throw new Error("No Claude API Key");
    const { system, history } = this.normalizeMsgs(msgs);
    const res = await window.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        // fetch from Obsidian's window sends an Origin header; Anthropic answers
        // such requests only with this header (requestUrl sends no Origin).
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        ...this.baseBody(model, system),
        messages: history,
        stream: true,
      }),
      signal,
    });
    if (!res.ok) throw new Error(`Claude stream error: ${await fetchError(res)}`);
    if (!res.body) throw new Error("Claude: no response body");
    return res.body.getReader();
  }
}
