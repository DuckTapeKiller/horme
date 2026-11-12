import { NativeTool } from "../skills/types";

/** Per-request choices a provider may honour. */
export interface StreamOptions {
  /** Answer without a thinking phase (local thinking models: llama.cpp, Ollama). */
  noThinking?: boolean;
}

export interface AiProvider {
  generate(prompt: string, system: string, model: string): Promise<string>;
  generateChat(msgs: Array<{ role: string; content: string }>, model: string): Promise<string>;
  stream(
    msgs: Array<{ role: string; content: string }>,
    model: string,
    signal?: AbortSignal,
    /** Native OpenAI-schema tools; only providers with tool support use it. */
    tools?: NativeTool[],
    options?: StreamOptions,
  ): Promise<ReadableStreamDefaultReader<Uint8Array>>;
}
