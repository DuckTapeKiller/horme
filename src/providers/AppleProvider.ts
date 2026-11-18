import type { AiProvider } from "./AiProvider";
import type { NativeTool } from "../skills/types";
import type { ApiMessage } from "./openAiChat";
import { OpenAiStyleProvider } from "./OpenAiStyleProvider";
import type { AppleModelServer } from "../services/AppleModelServer";

/** Apple's on-device model ("system"), or its larger model on Apple's Private Cloud Compute ("pcc"). */
export const APPLE_MODELS = ["system", "pcc"] as const;

/**
 * Apple Intelligence: Apple's Foundation Models through the local server
 * macOS runs for Horme (AppleModelServer). It speaks OpenAI's chat API, so
 * the requests are the shared OpenAI-style client's; this adds starting the
 * server and saying plainly why a model cannot be used.
 */
/** The context window of Apple's on-device model (`fm` reports "the maximum allowed is 8192"). */
export const APPLE_CONTEXT_TOKENS = 8192;

export class AppleProvider implements AiProvider {
  constructor(
    private readonly server: AppleModelServer,
    private readonly temperature: number,
    private readonly maxTokens: number,
  ) {}

  private async client(model: string): Promise<OpenAiStyleProvider> {
    const base = await this.server.baseUrl();
    const status = (await this.server.status()).find((m) => m.name === model);
    if (status && !status.available) throw new Error(`Apple Intelligence (${model}): ${status.reason}`);
    return new OpenAiStyleProvider({
      base,
      label: "Apple Intelligence",
      apiKey: "",
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      keyRequired: false,
      userServer: true,
    });
  }

  /** Apple's on-device model reads 8,192 tokens at most, prompt and tools included. */
  contextWindow(): Promise<number> {
    return Promise.resolve(APPLE_CONTEXT_TOKENS);
  }

  async generate(prompt: string, system: string, model: string): Promise<string> {
    const m = model.trim() || "system";
    return (await this.client(m)).generate(prompt, system, m);
  }

  async generateChat(msgs: ApiMessage[], model: string): Promise<string> {
    const m = model.trim() || "system";
    return (await this.client(m)).generateChat(msgs, m);
  }

  async stream(
    msgs: ApiMessage[],
    model: string,
    signal?: AbortSignal,
    tools?: NativeTool[],
  ): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    const m = model.trim() || "system";
    // Apple's server takes OpenAI's tool schema, so skills are offered as tools.
    return (await this.client(m)).stream(msgs, m, signal, tools);
  }
}
