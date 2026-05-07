import { requestUrl } from "obsidian";
import { AiProvider } from "./AiProvider";

export class LmStudioProvider implements AiProvider {
  private baseUrl: string;
  private temperature: number;

  constructor(baseUrl: string, temperature: number) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.temperature = temperature;
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
      })
    });
    return res.json?.choices?.[0]?.message?.content || "";
  }

  async stream(msgs: Array<{ role: string; content: string }>, model: string, signal?: AbortSignal): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    // LM Studio often supports OpenAI-style streaming. 
    // Since requestUrl doesn't support streaming well, we use fetch for local streaming if CORS allows.
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: msgs,
        temperature: this.temperature,
        stream: true
      }),
      signal
    });
    if (!response.ok || !response.body) throw new Error(`LM Studio stream error: ${response.status}`);
    return response.body.getReader();
  }
}
