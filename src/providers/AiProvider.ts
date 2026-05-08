export interface AiProvider {
  generate(prompt: string, system: string, model: string): Promise<string>;
  generateChat(msgs: Array<{ role: string; content: string }>, model: string): Promise<string>;
  stream(msgs: Array<{ role: string; content: string }>, model: string, signal?: AbortSignal): Promise<ReadableStreamDefaultReader<Uint8Array>>;
}

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  temperature: number;
}
