import { requestUrl } from "obsidian";
import { AiProvider } from "./AiProvider";

export class GroqProvider implements AiProvider {
  private apiKey: string;
  private temperature: number;

  constructor(apiKey: string, temperature: number) {
    this.apiKey = apiKey;
    this.temperature = temperature;
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
      })
    });
    return res.json?.choices?.[0]?.message?.content || "";
  }

  async stream(msgs: Array<{ role: string; content: string }>, model: string, signal?: AbortSignal): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    if (!this.apiKey) throw new Error("No Groq API Key");
    
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: msgs,
        temperature: this.temperature,
        stream: true
      }),
      signal
    });
    
    if (!response.ok || !response.body) throw new Error(`Groq stream error: ${response.status}`);
    return response.body.getReader();
  }
}
