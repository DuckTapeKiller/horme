import { requestUrl } from "obsidian";
import { asArray, getRecordProp, getStringProp } from "../utils/TypeGuards";
import { bearer } from "../utils/providerAccess";
import { LocalServerProvider } from "./LocalServerProvider";

export class LmStudioProvider extends LocalServerProvider {
  protected readonly label = "LM Studio";

  private isEmbeddingModel(id: string, type: string): boolean {
    return /embed/i.test(id) || /embed/i.test(type);
  }

  /** Models LM Studio reports, with load state (native /api/v0/models). */
  private async listModels(): Promise<Array<{ id: string; state: string; type: string }>> {
    try {
      const res = await requestUrl({
        url: `${this.baseUrl}/api/v0/models`,
        headers: bearer(this.apiKey),
        throw: false,
      });
      if (res.status === 200) {
        const dataArr = asArray(getRecordProp(res.json as unknown, "data")) ?? [];
        return dataArr
          .map((m) => ({
            id: getStringProp(m, "id") ?? "",
            state: getStringProp(m, "state") ?? "",
            type: getStringProp(m, "type") ?? "",
          }))
          .filter((m) => m.id);
      }
    } catch {
      // native endpoint unavailable; the caller falls back to /v1/models
    }
    return [];
  }

  /**
   * Resolves "Automatic" (empty model) to a concrete model id: prefer an
   * already-loaded LLM, then the first non-embedding model the server reports.
   */
  private async resolveModel(model: string): Promise<string> {
    if (model) return model;
    const native = await this.listModels();
    const loaded = native.find((m) => m.state === "loaded" && !this.isEmbeddingModel(m.id, m.type));
    if (loaded) return loaded.id;
    const firstNative = native.find((m) => !this.isEmbeddingModel(m.id, m.type));
    if (firstNative) return firstNative.id;
    try {
      const res = await requestUrl({
        url: `${this.baseUrl}/v1/models`,
        headers: bearer(this.apiKey),
        throw: false,
      });
      if (res.status === 200) {
        const dataArr = asArray(getRecordProp(res.json as unknown, "data")) ?? [];
        const ids = dataArr.map((m) => getStringProp(m, "id")).filter((id): id is string => Boolean(id));
        const firstChat = ids.find((id) => !/embed/i.test(id));
        if (firstChat) return firstChat;
      }
    } catch {
      // leave unresolved; the chat request will surface the real error
    }
    return "";
  }

  /**
   * Loads the model into LM Studio if it is not already loaded. JIT loading is
   * unreliable and can be disabled, so we load explicitly via the REST endpoint
   * (v1, with a v0 fallback) rather than depending on it. This does not evict an
   * already-loaded embedding model, so RAG indexing keeps working. Best-effort:
   * on any failure we proceed and let the chat request report the real error.
   * Uses requestUrl (Obsidian) because LM Studio ships with CORS disabled and
   * the plugin origin is app://obsidian.md.
   */
  private async ensureModelLoaded(model: string): Promise<void> {
    if (!model) return;
    const native = await this.listModels();
    if (native.some((m) => m.id === model && m.state === "loaded")) return;
    for (const path of ["/api/v1/models/load", "/api/v0/models/load"]) {
      try {
        const res = await requestUrl({
          url: `${this.baseUrl}${path}`,
          method: "POST",
          headers: { "Content-Type": "application/json", ...bearer(this.apiKey) },
          body: JSON.stringify({ model }),
          throw: false,
        });
        if (res.status === 200) return;
        // 404 -> endpoint absent on this build, try the next; else give up.
        if (res.status !== 404) return;
      } catch {
        return;
      }
    }
  }

  protected async prepareModel(model: string): Promise<string> {
    const resolved = await this.resolveModel(model);
    await this.ensureModelLoaded(resolved);
    return resolved;
  }
}
