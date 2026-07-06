import { NativeTool } from "../skills/types";

export interface AiProvider {
  generate(prompt: string, system: string, model: string): Promise<string>;
  generateChat(msgs: Array<{ role: string; content: string }>, model: string): Promise<string>;
  stream(
    msgs: Array<{ role: string; content: string }>,
    model: string,
    signal?: AbortSignal,
    /** Native OpenAI-schema tools; only providers with tool support use it. */
    tools?: NativeTool[],
  ): Promise<ReadableStreamDefaultReader<Uint8Array>>;
}
