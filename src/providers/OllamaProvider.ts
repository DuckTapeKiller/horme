import { AiProvider } from "./AiProvider";

export class OllamaProvider implements AiProvider {
  private baseUrl: string;
  private temperature: number;

  constructor(baseUrl: string, temperature: number) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.temperature = temperature;
  }

  private async readOllamaErrorDetail(response: Response): Promise<string> {
    let text = "";
    try {
      text = (await response.text()) ?? "";
    } catch {
      return "";
    }

    const trimmed = text.trim();
    if (!trimmed) return "";

    try {
      const parsed = JSON.parse(trimmed);
      if (parsed?.error) return String(parsed.error);
    } catch {
      // Not JSON (e.g., "404 page not found") — keep raw text.
    }
    return trimmed;
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
    if (!response.ok) {
      const detail = await this.readOllamaErrorDetail(response);
      throw new Error(`Ollama error: ${response.status}${detail ? ` - ${detail}` : ""}`);
    }
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
    if (!response.ok) {
      const detail = await this.readOllamaErrorDetail(response);
      throw new Error(`Ollama chat error: ${response.status}${detail ? ` - ${detail}` : ""}`);
    }
    const data = await response.json();
    if (!data.message?.content && data.error) throw new Error(`Ollama: ${data.error}`);
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
    if (!response.ok || !response.body) {
      const detail = await this.readOllamaErrorDetail(response);
      throw new Error(`Ollama stream error: ${response.status}${detail ? ` - ${detail}` : ""}`);
    }
    return response.body.getReader();
  }
}
