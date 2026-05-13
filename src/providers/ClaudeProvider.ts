import { requestUrl } from "obsidian";
import { AiProvider } from "./AiProvider";
import { createAssistantContentReader } from "./StreamUtils";
import { asArray, errorToMessage, getRecordProp, getStringProp } from "../utils/TypeGuards";

type ClaudeMessage = { role: "user" | "assistant"; content: string };

export class ClaudeProvider implements AiProvider {
  private apiKey: string;
  private temperature: number;

  constructor(apiKey: string, temperature: number) {
    this.apiKey = apiKey;
    this.temperature = temperature;
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

  private normalizeMsgs(msgs: Array<{ role: string; content: string }>): { system: string; history: ClaudeMessage[] } {
    const system = msgs.find(m => m.role === "system")?.content ?? "";
    const history: ClaudeMessage[] = [];
    for (const m of msgs) {
      if (m.role === "system") continue;
      if (m.role === "assistant" || m.role === "user") {
        history.push({ role: m.role, content: m.content });
      } else {
        history.push({ role: "user", content: m.content });
      }
    }
    return { system, history };
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
        model,
        max_tokens: 2048,
        system,
        messages: [{ role: "user", content: prompt }],
        temperature: this.temperature,
      }),
      throw: false,
    });

    if (res.status !== 200) throw new Error(`Claude error: ${res.status}`);
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
        model,
        max_tokens: 2048,
        temperature: this.temperature,
        system,
        messages: history,
      }),
      throw: false,
    });

    if (res.status !== 200) throw new Error(`Claude error: ${res.status}`);
    return this.extractText(res.json as unknown);
  }

  async stream(
    msgs: Array<{ role: string; content: string }>,
    model: string,
    signal?: AbortSignal
  ): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    try {
      const full = await this.generateChat(msgs, model);
      return createAssistantContentReader(full, signal);
    } catch (e: unknown) {
      throw new Error(errorToMessage(e));
    }
  }
}

