import { AiProvider } from "./AiProvider";

export class OllamaProvider implements AiProvider {
  private baseUrl: string;
  private temperature: number;

  constructor(baseUrl: string, temperature: number) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.temperature = temperature;
  }

  async generate(prompt: string, system: string, model: string): Promise<string> {
    const url = `${this.baseUrl}/api/generate`;
    const response = await fetch(url, {
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
    if (!response.ok) throw new Error(`Ollama error: ${response.status}`);
    const data = await response.json();
    if (!data.response && data.error) throw new Error(`Ollama: ${data.error}`);
    return data.response ?? "";
  }
  
  async generateChat(msgs: Array<{ role: string; content: string }>, model: string): Promise<string> {
    const url = `${this.baseUrl}/api/chat`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: msgs,
        stream: false,
        options: { temperature: this.temperature },
      }),
    });
    if (!response.ok) throw new Error(`Ollama chat error: ${response.status}`);
    const data = await response.json();
    return data.message?.content ?? "";
  }

  async stream(msgs: Array<{ role: string; content: string }>, model: string, signal?: AbortSignal): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    const url = `${this.baseUrl}/api/chat`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: msgs,
        stream: true,
        options: { temperature: this.temperature },
      }),
      signal
    });
    if (!response.ok || !response.body) throw new Error(`Ollama stream error: ${response.status}`);
    return response.body.getReader();
  }
}
