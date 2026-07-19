import { requestUrl } from "obsidian";
import { AiProvider } from "./AiProvider";
import { requestUrlError } from "../utils/apiError";
import { asArray, getRecordProp, getStringProp } from "../utils/TypeGuards";
import { normalizeBaseUrl } from "../utils/normalizeBaseUrl";
import { streamOpenAiCompatible } from "../utils/localStream";
import { NativeTool } from "../skills/types";

export class LlamaCppProvider implements AiProvider {
  private baseUrl: string;
  private temperature: number;
  private maxTokens: number;

  constructor(baseUrl: string, temperature: number, maxTokens: number) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.temperature = temperature;
    this.maxTokens = maxTokens;
  }

  private extractContent(json: unknown): string {
    const choices = asArray(getRecordProp(json, "choices")) ?? [];
    const first = choices[0];
    const message = getRecordProp(first, "message");
    return getStringProp(message, "content") ?? "";
  }

  private isEmbeddingModel(id: string): boolean {
    return /embed/i.test(id);
  }

  /**
   * Models the llama-server reports. In router mode (`--models-dir` /
   * `--models-preset`) each entry carries a status ("loaded" | "sleeping" |
   * "unloaded"); a classic single-model server has no status, so its model is
   * treated as loaded.
   */
  private async listModels(): Promise<Array<{ id: string; state: string }>> {
    try {
      const res = await requestUrl({ url: `${this.baseUrl}/v1/models`, throw: false });
      if (res.status === 200) {
        const dataArr = asArray(getRecordProp(res.json as unknown, "data")) ?? [];
        return dataArr
          .map((m) => {
            const status = getRecordProp(m, "status");
            return {
              id: getStringProp(m, "id") ?? getStringProp(m, "name") ?? "",
              state: getStringProp(status, "value") ?? "loaded",
            };
          })
          .filter((m) => m.id);
      }
    } catch {
      // server unreachable; the chat request will surface the real error
    }
    return [];
  }

  /**
   * Resolves "Automatic" (empty model) to a concrete model id: prefer an
   * already-loaded (or sleeping) chat model, then the first non-embedding
   * model the server reports.
   */
  private async resolveModel(model: string): Promise<string> {
    if (model) return model;
    const models = await this.listModels();
    const active = models.find(
      (m) => (m.state === "loaded" || m.state === "sleeping") && !this.isEmbeddingModel(m.id),
    );
    if (active) return active.id;
    const first = models.find((m) => !this.isEmbeddingModel(m.id));
    return first ? first.id : "";
  }

  /**
   * Router mode loads models on demand and evicts per its own policy
   * (`--models-max`), so an explicit load is normally unnecessary — but it
   * makes the first token arrive faster and gives a clear error path when
   * autoload is disabled (`--no-models-autoload`). Best-effort: a classic
   * single-model server answers 404 here and simply serves what it was
   * started with.
   */
  private async ensureModelLoaded(model: string): Promise<void> {
    if (!model) return;
    const models = await this.listModels();
    const entry = models.find((m) => m.id === model);
    if (!entry || entry.state === "loaded") return;
    try {
      await requestUrl({
        url: `${this.baseUrl}/models/load`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
        throw: false,
      });
    } catch {
      // proceed; the chat request reports the real error
    }
  }

  /** Resolve "Automatic" to a concrete model and ensure it is loaded. */
  private async prepareModel(model: string): Promise<string> {
    const resolved = await this.resolveModel(model);
    await this.ensureModelLoaded(resolved);
    return resolved;
  }

  async generate(prompt: string, system: string, model: string): Promise<string> {
    const resolvedModel = await this.prepareModel(model);
    const res = await requestUrl({
      url: `${this.baseUrl}/v1/chat/completions`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: resolvedModel,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        temperature: this.temperature,
        max_tokens: this.maxTokens,
        stream: false,
      }),
      throw: false,
    });
    if (res.status !== 200) throw new Error(`llama.cpp error: ${requestUrlError(res)}`);
    return this.extractContent(res.json as unknown);
  }

  async generateChat(msgs: Array<{ role: string; content: string }>, model: string): Promise<string> {
    const resolvedModel = await this.prepareModel(model);
    const res = await requestUrl({
      url: `${this.baseUrl}/v1/chat/completions`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: resolvedModel,
        messages: msgs,
        temperature: this.temperature,
        max_tokens: this.maxTokens,
        stream: false,
      }),
      throw: false,
    });
    if (res.status !== 200) throw new Error(`llama.cpp error: ${requestUrlError(res)}`);
    return this.extractContent(res.json as unknown);
  }

  async stream(
    msgs: Array<{ role: string; content: string }>,
    model: string,
    signal?: AbortSignal,
    tools?: NativeTool[],
  ): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    const resolvedModel = await this.prepareModel(model);
    const body: Record<string, unknown> = {
      model: resolvedModel,
      messages: msgs,
      temperature: this.temperature,
      max_tokens: this.maxTokens,
      stream: true,
    };
    if (tools && tools.length) body.tools = tools;
    // CORS-proof transport chain (llama-server has no CORS allowance for
    // Obsidian's app://obsidian.md origin): Node http → fetch → requestUrl.
    return streamOpenAiCompatible(`${this.baseUrl}/v1/chat/completions`, body, signal);
  }
}
