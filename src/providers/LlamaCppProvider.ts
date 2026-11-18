import { requestUrl } from "obsidian";
import { asArray, getRecordProp, getStringProp } from "../utils/TypeGuards";
import { bearer } from "../utils/providerAccess";
import { LocalServerProvider } from "./LocalServerProvider";
import { requestUrlWithTimeout } from "../utils/requestWithTimeout";
import { thinkingSwitchAtTop } from "../utils/chatTemplate";

/** Per server and model: does turning thinking off keep the prompt's start? Asked once. */
const prefixKept = new Map<string, Promise<boolean>>();

export class LlamaCppProvider extends LocalServerProvider {
  protected readonly label = "llama.cpp";

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
      const res = await requestUrl({
        url: `${this.baseUrl}/v1/models`,
        headers: bearer(this.apiKey),
        throw: false,
      });
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
        headers: { "Content-Type": "application/json", ...bearer(this.apiKey) },
        body: JSON.stringify({ model }),
        throw: false,
      });
    } catch {
      // proceed; the chat request reports the real error
    }
  }

  protected async prepareModel(model: string): Promise<string> {
    const resolved = await this.resolveModel(model);
    await this.ensureModelLoaded(resolved);
    return resolved;
  }

  /**
   * Asks the server to render a two-line conversation with thinking on and
   * off (`/apply-template`) and compares where they differ. An older server
   * without the endpoint is taken at its word.
   */
  protected thinkingOffKeepsPrefix(model: string): Promise<boolean> {
    const key = `${this.baseUrl}|${model}`;
    let known = prefixKept.get(key);
    if (!known) {
      const user = "Horme template probe question";
      const render = async (thinking: boolean): Promise<string> => {
        const res = await requestUrlWithTimeout(
          {
            url: `${this.baseUrl}/apply-template`,
            method: "POST",
            headers: { "Content-Type": "application/json", ...bearer(this.apiKey) },
            body: JSON.stringify({
              model,
              messages: [
                { role: "system", content: "Horme template probe" },
                { role: "user", content: user },
              ],
              chat_template_kwargs: { enable_thinking: thinking },
            }),
            throw: false,
          },
          8000,
        );
        const prompt = res.status === 200 ? getStringProp(res.json as unknown, "prompt") : undefined;
        if (prompt === undefined) throw new Error("no rendered prompt");
        return prompt;
      };
      known = Promise.all([render(true), render(false)])
        .then(([on, off]) => !thinkingSwitchAtTop(on, off, user))
        .catch(() => {
          prefixKept.delete(key); // asked again next time
          return true;
        });
      prefixKept.set(key, known);
    }
    return known;
  }

  /** The window of each slot the server gives the model (`/props`), or null when it will not say. */
  async contextWindow(model: string): Promise<number | null> {
    try {
      const resolved = await this.resolveModel(model);
      const res = await requestUrlWithTimeout(
        {
          url: `${this.baseUrl}/props${resolved ? `?model=${encodeURIComponent(resolved)}` : ""}`,
          headers: bearer(this.apiKey),
          throw: false,
        },
        5000,
      );
      if (res.status !== 200) return null;
      const nCtx = getRecordProp(getRecordProp(res.json as unknown, "default_generation_settings"), "n_ctx");
      return typeof nCtx === "number" && nCtx > 0 ? nCtx : null;
    } catch {
      return null;
    }
  }

  /** llama.cpp's chat templates take a switch that turns thinking off. */
  protected thinkingOff(): Record<string, unknown> {
    return { chat_template_kwargs: { enable_thinking: false } };
  }
}
