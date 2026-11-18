import { requestUrl } from "obsidian";
import { AiProvider, StreamOptions } from "./AiProvider";
import { asArray, getRecordProp, getStringProp } from "../utils/TypeGuards";
import { fetchError, requestUrlError } from "../utils/apiError";
import { normalizeBaseUrl } from "../utils/normalizeBaseUrl";
import { bearer } from "../utils/providerAccess";
import { streamWithNode } from "../utils/localStream";
import { ollamaNumCtx, wasCut } from "../utils/contextOverflow";
import { NativeTool } from "../skills/types";

/** What Ollama says about a model: whether it thinks, and the context length it was built for. */
interface ModelFacts {
  thinking: boolean;
  contextLength: number | null;
}

/**
 * Model facts by server and name, asked once per session (a provider object
 * lives for one request). Only answers are kept: a failed question is asked
 * again next time.
 */
const modelFacts = new Map<string, Promise<ModelFacts | null>>();

export class OllamaProvider implements AiProvider {
  private baseUrl: string;
  private temperature: number;
  private maxTokens: number;

  /** The server's API key, sent only when there is one. */
  private apiKey: string;

  /** Told when Ollama cut a request to fit the context window. */
  private onWarning?: (message: string) => void;

  /** The context window setting (num_ctx); 0 leaves it to Ollama. */
  private contextLength: number;

  constructor(
    baseUrl: string,
    temperature: number,
    maxTokens: number,
    apiKey = "",
    onWarning?: (message: string) => void,
    contextLength = 0,
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.temperature = temperature;
    this.maxTokens = maxTokens;
    this.apiKey = apiKey;
    this.onWarning = onWarning;
    this.contextLength = contextLength;
  }

  private checkCut(promptChars: number, promptTokens: unknown): void {
    if (!wasCut(promptChars, promptTokens)) return;
    this.onWarning?.(
      `Ollama cut this request to fit the model's context window: it read ${Number(promptTokens).toLocaleString("en-GB")} tokens of about ${Math.round(promptChars / 4).toLocaleString("en-GB")}, leaving out the start, where Horme's instructions and your note passages are. ` +
        (this.contextLength > 0
          ? `Raise Context window on Ollama's page in Horme's Models settings (now ${Math.floor(this.contextLength).toLocaleString("en-GB")} tokens).`
          : "Set Context window on Ollama's page in Horme's Models settings: it is left to Ollama now, and 16,384 tokens suits Horme with Vault Brain."),
    );
  }

  private static chars(msgs: Array<{ content: string }>): number {
    return msgs.reduce((n, m) => n + (m.content?.length ?? 0), 0);
  }

  /**
   * Passes the streamed reply through unchanged, reading Ollama's closing
   * line (done, with prompt_eval_count) on the way to see whether the
   * request was cut. Stop and errors reach the reader as before.
   */
  private watch(
    source: ReadableStreamDefaultReader<Uint8Array>,
    promptChars: number,
  ): ReadableStreamDefaultReader<Uint8Array> {
    const decoder = new TextDecoder();
    let tail = "";
    // Only the closing line carries the counts; every other line says
    // "done":false and is left to the reader, not parsed a second time here.
    const inspect = (line: string) => {
      if (!/"done"\s*:\s*true/.test(line)) return;
      try {
        const data: unknown = JSON.parse(line);
        if (getRecordProp(data, "done") === true)
          this.checkCut(promptChars, getRecordProp(data, "prompt_eval_count"));
      } catch {
        // not a whole line of JSON: nothing to read
      }
    };
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const { done, value } = await source.read();
          if (done) {
            if (tail) inspect(tail);
            controller.close();
            return;
          }
          tail += decoder.decode(value, { stream: true });
          const lines = tail.split("\n");
          tail = lines.pop() ?? "";
          lines.forEach(inspect);
          controller.enqueue(value);
        } catch (e: unknown) {
          controller.error(e);
        }
      },
      cancel: (reason) => source.cancel(reason),
    }).getReader();
  }

  /** Ollama's own facts about the model (/api/show), or null when it would not say. */
  private facts(model: string): Promise<ModelFacts | null> {
    const key = `${this.baseUrl}|${model}`;
    const known = modelFacts.get(key);
    if (known) return known;
    const asking = requestUrl({
      url: `${this.baseUrl}/api/show`,
      method: "POST",
      headers: { "Content-Type": "application/json", ...bearer(this.apiKey) },
      body: JSON.stringify({ model }),
      throw: false,
    })
      .then((res): ModelFacts => {
        if (res.status !== 200) throw new Error(String(res.status));
        const json = res.json as unknown;
        const capabilities = asArray(getRecordProp(json, "capabilities")) ?? [];
        // model_info names it after the architecture: "qwen35.context_length".
        const info = getRecordProp(json, "model_info");
        let contextLength: number | null = null;
        if (info && typeof info === "object") {
          for (const [k, v] of Object.entries(info as Record<string, unknown>)) {
            if (k.endsWith(".context_length") && typeof v === "number" && v > 0) contextLength = v;
          }
        }
        return { thinking: capabilities.includes("thinking"), contextLength };
      })
      .catch(() => {
        modelFacts.delete(key);
        return null;
      });
    modelFacts.set(key, asking);
    return asking;
  }

  /**
   * Thinking is switched off only for models Ollama says have it, so a model
   * without it is sent exactly what it was sent before.
   */
  private async canThink(model: string): Promise<boolean> {
    return (await this.facts(model))?.thinking ?? false;
  }

  /**
   * The model options for every chat request: temperature, the reply budget,
   * and the context window from the setting (capped at the model's own
   * length). The same window every time, so Ollama loads the model once
   * rather than reloading it between requests.
   */
  private async modelOptions(model: string): Promise<Record<string, number>> {
    const options: Record<string, number> = { temperature: this.temperature, num_predict: this.maxTokens };
    if (this.contextLength > 0) {
      const [facts, loaded] = await Promise.all([this.facts(model), this.loadedContext(model)]);
      const numCtx = ollamaNumCtx(this.contextLength, facts?.contextLength ?? null, loaded);
      if (numCtx) options.num_ctx = numCtx;
    }
    return options;
  }

  /** The window chats with this model get: the one Horme asks for, or the one it is loaded with. */
  async contextWindow(model: string): Promise<number | null> {
    if (this.contextLength > 0) {
      const [facts, loaded] = await Promise.all([this.facts(model), this.loadedContext(model)]);
      return ollamaNumCtx(this.contextLength, facts?.contextLength ?? null, loaded) || null;
    }
    return this.loadedContext(model);
  }

  /**
   * The window the model is loaded with now (/api/ps), or null when it is not
   * loaded or Ollama would not say. Asked on every request: another app may
   * have reloaded it since.
   */
  private async loadedContext(model: string): Promise<number | null> {
    try {
      const res = await requestUrl({
        url: `${this.baseUrl}/api/ps`,
        headers: bearer(this.apiKey),
        throw: false,
      });
      if (res.status !== 200) return null;
      const wanted = model.includes(":") ? model : `${model}:latest`;
      for (const m of asArray(getRecordProp(res.json as unknown, "models")) ?? []) {
        const name = getStringProp(m, "name") ?? getStringProp(m, "model");
        const ctx = getRecordProp(m, "context_length");
        if (name === wanted && typeof ctx === "number" && ctx > 0) return ctx;
      }
    } catch {
      // Not known: the setting alone decides.
    }
    return null;
  }

  /**
   * One-shot jobs (text actions, tags, summaries, translations, search
   * queries) need no reasoning: a thinking model took 15 s over a one-word
   * answer that takes 1 s without, as llama.cpp's one-shot calls already do.
   */
  private async noThinking(model: string): Promise<Record<string, boolean>> {
    return (await this.canThink(model)) ? { think: false } : {};
  }

  async generate(prompt: string, system: string, model: string): Promise<string> {
    const url = `${this.baseUrl}/api/generate`;
    const response = await requestUrl({
      url,
      method: "POST",
      headers: { "Content-Type": "application/json", ...bearer(this.apiKey) },
      body: JSON.stringify({
        model,
        prompt,
        system,
        stream: false,
        ...(await this.noThinking(model)),
        options: await this.modelOptions(model),
      }),
      throw: false,
    });

    if (response.status !== 200) throw new Error(`Ollama error: ${requestUrlError(response)}`);
    const data: unknown = response.json;
    const error = getStringProp(data, "error");
    const content = getStringProp(data, "response") ?? "";
    if (!content && error) throw new Error(`Ollama: ${error}`);
    this.checkCut(prompt.length + system.length, getRecordProp(data, "prompt_eval_count"));
    return content;
  }

  async generateChat(msgs: Array<{ role: string; content: string }>, model: string): Promise<string> {
    const url = `${this.baseUrl}/api/chat`;
    const response = await requestUrl({
      url,
      method: "POST",
      headers: { "Content-Type": "application/json", ...bearer(this.apiKey) },
      body: JSON.stringify({
        model,
        messages: msgs,
        stream: false,
        ...(await this.noThinking(model)),
        options: await this.modelOptions(model),
      }),
      throw: false,
    });

    if (response.status !== 200) throw new Error(`Ollama error: ${requestUrlError(response)}`);
    const data: unknown = response.json;
    const error = getStringProp(data, "error");
    const message = getRecordProp(data, "message");
    const content = getStringProp(message, "content") ?? "";
    if (!content && error) throw new Error(`Ollama: ${error}`);
    this.checkCut(OllamaProvider.chars(msgs), getRecordProp(data, "prompt_eval_count"));
    return content;
  }

  async stream(
    msgs: Array<{ role: string; content: string }>,
    model: string,
    signal?: AbortSignal,
    tools?: NativeTool[],
    options?: StreamOptions,
  ): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    const body: Record<string, unknown> = {
      model,
      messages: msgs,
      stream: true,
      options: await this.modelOptions(model),
    };
    // Ollama's /api/chat native tools API (tool-trained models emit
    // structured message.tool_calls instead of prompt-taught XML).
    if (tools && tools.length) body.tools = tools;
    // Writing the reply from a skill result needs no second thinking phase.
    if (options?.noThinking && (await this.canThink(model))) body.think = false;
    // Ollama itself has no keys; a key means a proxy in front of it, which
    // will not know Obsidian's app:// origin, so on a computer the request
    // goes through Node, which no CORS rule blocks. Without a key the
    // request is sent exactly as before.
    if (this.apiKey.trim()) {
      const viaNode = streamWithNode(`${this.baseUrl}/api/chat`, body, signal, bearer(this.apiKey));
      if (viaNode) return this.watch(await viaNode, OllamaProvider.chars(msgs));
    }
    let res: Response;
    try {
      res = await window.fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...bearer(this.apiKey) },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      // The browser blocked the answer (a proxy that refused the request, or
      // an Ollama elsewhere that does not allow Obsidian's origin) and hid the
      // reason behind "Failed to fetch". Node is not subject to that block: it
      // gets the reply, or the server's real error.
      if (e instanceof TypeError) {
        const viaNode = streamWithNode(`${this.baseUrl}/api/chat`, body, signal, bearer(this.apiKey));
        if (viaNode) return this.watch(await viaNode, OllamaProvider.chars(msgs));
      }
      throw e;
    }
    if (!res.ok) throw new Error(`Ollama stream error: ${await fetchError(res)}`);
    if (!res.body) throw new Error("Ollama: no response body");
    return this.watch(res.body.getReader(), OllamaProvider.chars(msgs));
  }
}
