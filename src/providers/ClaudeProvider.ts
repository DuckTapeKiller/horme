import { requestUrl } from "obsidian";
import { AiProvider } from "./AiProvider";

export class ClaudeProvider implements AiProvider {
  private apiKey: string;
  private temperature: number;

  constructor(apiKey: string, temperature: number) {
    this.apiKey = apiKey;
    this.temperature = temperature;
  }

  async generate(prompt: string, system: string, model: string): Promise<string> {
    if (!this.apiKey) throw new Error("No Claude API Key");
    const res = await requestUrl({
      url: "https://api.anthropic.com/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        temperature: this.temperature,
        system,
        messages: [{ role: "user", content: prompt }]
      })
    });
    return res.json?.content?.[0]?.text || "";
  }

  async generateChat(msgs: Array<{ role: string; content: string }>, model: string): Promise<string> {
    if (!this.apiKey) throw new Error("No Claude API Key");
    const system = msgs.find(m => m.role === "system")?.content || "";
    const history = msgs.filter(m => m.role !== "system");
    const res = await requestUrl({
      url: "https://api.anthropic.com/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        temperature: this.temperature,
        system,
        messages: history
      })
    });
    return res.json?.content?.[0]?.text || "";
  }

  async stream(msgs: Array<{ role: string; content: string }>, model: string, signal?: AbortSignal): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    if (!this.apiKey) throw new Error("No Claude API Key");
    
    // We split system from history for Claude's specific API
    const system = msgs.find(m => m.role === "system")?.content || "";
    const history = msgs.filter(m => m.role !== "system");

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "dangerously-allow-browser": "true"
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        temperature: this.temperature,
        system,
        messages: history,
        stream: true
      }),
      signal
    });
    
    if (!response.ok || !response.body) throw new Error(`Claude stream error: ${response.status}`);
    return response.body.getReader();
  }
}
