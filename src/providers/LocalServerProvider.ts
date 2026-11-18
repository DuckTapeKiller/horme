import type { AiProvider, StreamOptions } from "./AiProvider";
import { completeChat, type ApiMessage } from "./openAiChat";
import type { NativeTool } from "../skills/types";
import { bearer } from "../utils/providerAccess";
import { normalizeBaseUrl } from "../utils/normalizeBaseUrl";
import { streamOpenAiCompatible } from "../utils/localStream";

/**
 * A chat server on the user's machines that speaks OpenAI's chat API with
 * extras: llama.cpp and LM Studio. They share every request; each finds and
 * loads its model its own way, and may have a switch that turns thinking off.
 */
export abstract class LocalServerProvider implements AiProvider {
  protected readonly baseUrl: string;

  /** The server's name, for error messages. */
  protected abstract readonly label: string;

  constructor(
    baseUrl: string,
    protected readonly temperature: number,
    protected readonly maxTokens: number,
    /** The server's API key, sent only when there is one. */
    protected readonly apiKey = "",
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  /** "Automatic" (an empty model) resolved to a model the server has, loaded and ready. */
  protected abstract prepareModel(model: string): Promise<string>;

  /**
   * Request fields for a reply without a thinking phase, {} when the server
   * has no such switch. One-shot jobs always send them; the chat sends them
   * for the round after a skill.
   */
  protected thinkingOff(): Record<string, unknown> {
    return {};
  }

  /**
   * Whether turning thinking off leaves the start of the prompt as it is, so
   * the server can reuse what it read for the round before. Servers that can
   * show a rendered prompt check it; the others are taken at their word.
   */
  protected thinkingOffKeepsPrefix(_model: string): Promise<boolean> {
    return Promise.resolve(true);
  }

  private get url(): string {
    return `${this.baseUrl}/v1/chat/completions`;
  }

  generate(prompt: string, system: string, model: string): Promise<string> {
    return this.generateChat(
      [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      model,
    );
  }

  async generateChat(msgs: ApiMessage[], model: string): Promise<string> {
    const resolved = await this.prepareModel(model);
    // One-shot jobs (tag translation, search queries, text actions) need no
    // reasoning: a thinking model spent the whole budget on it and returned
    // nothing (tag translation came back empty with gemma 4).
    return completeChat(
      this.url,
      bearer(this.apiKey),
      {
        model: resolved,
        messages: msgs,
        temperature: this.temperature,
        max_tokens: this.maxTokens,
        ...this.thinkingOff(),
      },
      this.label,
    );
  }

  async stream(
    msgs: ApiMessage[],
    model: string,
    signal?: AbortSignal,
    tools?: NativeTool[],
    options?: StreamOptions,
  ): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    const resolved = await this.prepareModel(model);
    const body: Record<string, unknown> = {
      model: resolved,
      messages: msgs,
      temperature: this.temperature,
      max_tokens: this.maxTokens,
      stream: true,
    };
    if (tools && tools.length) body.tools = tools;
    // Writing the reply from a skill result needs no second thinking phase,
    // unless switching it off rewrites the top of the prompt (gemma 4): then
    // re-reading the whole prompt costs far more than a short think.
    if (options?.noThinking && (await this.thinkingOffKeepsPrefix(resolved)))
      Object.assign(body, this.thinkingOff());
    // CORS-proof transport chain (these servers do not allow Obsidian's
    // app://obsidian.md origin): Node http → fetch → requestUrl.
    return streamOpenAiCompatible(this.url, body, signal, bearer(this.apiKey));
  }
}
