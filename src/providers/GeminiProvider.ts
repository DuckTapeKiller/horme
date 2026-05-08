import { requestUrl } from "obsidian";
import { AiProvider } from "./AiProvider";

export class GeminiProvider implements AiProvider {
  private apiKey: string;
  private temperature: number;

  constructor(apiKey: string, temperature: number) {
    this.apiKey = apiKey;
    this.temperature = temperature;
  }

  async generate(prompt: string, system: string, model: string): Promise<string> {
    if (!this.apiKey) throw new Error("No Gemini API Key");
    const res = await requestUrl({
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: (system ? system + "\n\n" : "") + prompt }] }],
        generationConfig: { temperature: this.temperature }
      })
    });
    return res.json?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  }

  async generateChat(msgs: Array<{ role: string; content: string }>, model: string): Promise<string> {
    if (!this.apiKey) throw new Error("No Gemini API Key");
    const system = msgs.find(m => m.role === "system")?.content;
    const history = msgs.filter(m => m.role !== "system").map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }]
    }));
    const res = await requestUrl({
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify({
        system_instruction: system ? { parts: [{ text: system }] } : undefined,
        contents: history,
        generationConfig: { temperature: this.temperature }
      })
    });
    return res.json?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  }
  async stream(msgs: Array<{ role: string; content: string }>, model: string, signal?: AbortSignal): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    if (!this.apiKey) throw new Error("No Gemini API Key");
    
    // Gemini handles system instruction separately in v1beta
    const system = msgs.find(m => m.role === "system")?.content;
    const history = msgs.filter(m => m.role !== "system").map(m => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }]
    }));

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify({
        system_instruction: system ? { parts: [{ text: system }] } : undefined,
        contents: history,
        generationConfig: { temperature: this.temperature }
      }),
      signal
    });
    
    if (!response.ok || !response.body) throw new Error(`Gemini stream error: ${response.status}`);
    return response.body.getReader();
  }
}
