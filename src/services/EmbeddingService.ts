import { requestUrl } from "obsidian";
import HormePlugin from "../../main";
import { asArray, asNumberArray, errorToMessage, getRecordProp, getStringProp } from "../utils/TypeGuards";
import { normalizeBaseUrl } from "../utils/normalizeBaseUrl";

export class EmbeddingService {
  private plugin: HormePlugin;

  constructor(plugin: HormePlugin) {
    this.plugin = plugin;
  }

  /** The local server that makes embeddings: the chat provider when local, else Ollama. */
  embeddingProvider(): "ollama" | "lmstudio" | "llamacpp" {
    const p = this.plugin.settings.aiProvider;
    return p === "ollama" || p === "lmstudio" || p === "llamacpp" ? p : "ollama";
  }

  /**
   * Names the embedding space: which server kind and model make the vectors.
   * Indexes store it, and vectors from different spaces are never compared.
   * "auto" means the server's loaded model is detected at run time.
   */
  embeddingFingerprint(): string {
    const s = this.plugin.settings;
    const p = this.embeddingProvider();
    if (p === "lmstudio") return `lmstudio:${s.lmStudioEmbeddingModel.trim() || "auto"}`;
    if (p === "llamacpp") return `llamacpp:${s.llamaCppEmbeddingModel.trim() || "auto"}`;
    return `ollama:${s.ragEmbeddingModel.trim() || "nomic-embed-text"}`;
  }

  /** True when an index labelled `stored` can be searched with the current set-up. */
  static sameSpace(stored: string, current: string): boolean {
    return !stored || stored === current;
  }

  /**
   * Indexes written before these labels stored only `ragEmbeddingModel` (which
   * may itself contain a colon, as in "nomic-embed-text:latest"), and were valid
   * while that setting was unchanged. Such a label becomes the current
   * fingerprint when it still matches; otherwise it is kept, and the index
   * counts as built with another set-up.
   */
  upgradeLegacyLabel(stored: string): string {
    if (!stored || /^(ollama|lmstudio|llamacpp):/.test(stored)) return stored;
    return stored === this.plugin.settings.ragEmbeddingModel.trim() ? this.embeddingFingerprint() : stored;
  }

  /**
   * The embedding model's name, for the prefix conventions some models need
   * (nomic, mxbai). Known once the model has been detected; call
   * resolveEmbeddingModelName() first to make sure.
   */
  embeddingModelName(): string {
    const s = this.plugin.settings;
    const p = this.embeddingProvider();
    if (p === "lmstudio") return s.lmStudioEmbeddingModel.trim() || this.lmStudioDetectedEmbeddingModel || "";
    if (p === "llamacpp") return s.llamaCppEmbeddingModel.trim() || this.llamaCppDetectedEmbeddingModel || "";
    return s.ragEmbeddingModel.trim() || "nomic-embed-text";
  }

  async resolveEmbeddingModelName(): Promise<string> {
    const p = this.embeddingProvider();
    try {
      if (p === "lmstudio") return await this.resolveLmStudioEmbeddingModel();
      if (p === "llamacpp") return await this.resolveLlamaCppEmbeddingModel();
    } catch {
      // The embedding call itself reports the problem; the name only picks prefixes.
    }
    return this.embeddingModelName();
  }

  /**
   * Generates embeddings for a single text chunk.
   */
  async getEmbedding(text: string): Promise<number[]> {
    const results = await this.getEmbeddings([text]);
    return results[0];
  }

  /**
   * Generates embeddings for multiple text chunks in a single batch request.
   */
  async getEmbeddings(texts: string[]): Promise<number[][]> {
    const embedProvider = this.embeddingProvider();

    const BATCH_SIZE = 32;
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE).map((t) => t.replace(/\0/g, "").trim());

      try {
        allEmbeddings.push(...(await this.embedBatch(embedProvider, batch)));
      } catch (e: unknown) {
        // One text over the server's limit fails the whole batch (llama.cpp:
        // "input (533 tokens) is too large to process"), and the note was then
        // left out of the index. Embed one by one, shortening only a text that
        // is still refused: its passage stays whole, only its vector reads less.
        if (!EmbeddingService.isSizeError(e)) throw e;
        for (const text of batch) allEmbeddings.push(await this.embedOneShortening(embedProvider, text));
      }
    }
    return allEmbeddings;
  }

  private async embedBatch(
    provider: "ollama" | "lmstudio" | "llamacpp",
    batch: string[],
  ): Promise<number[][]> {
    if (provider === "ollama") return this.getOllamaEmbeddingsBatch(batch);
    if (provider === "lmstudio") return this.getLMStudioEmbeddingsBatch(batch);
    return this.getLlamaCppEmbeddingsBatch(batch);
  }

  private static isSizeError(e: unknown): boolean {
    return /too large|too long|exceed|context|maximum|token|413|physical batch/i.test(errorToMessage(e));
  }

  private async embedOneShortening(
    provider: "ollama" | "lmstudio" | "llamacpp",
    text: string,
  ): Promise<number[]> {
    let lastError: unknown = null;
    for (const share of [1, 0.75, 0.5, 0.3]) {
      const input = share === 1 ? text : text.slice(0, Math.max(50, Math.floor(text.length * share)));
      try {
        const [vector] = await this.embedBatch(provider, [input]);
        if (vector) return vector;
      } catch (e: unknown) {
        lastError = e;
        if (!EmbeddingService.isSizeError(e)) break;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(errorToMessage(lastError));
  }

  private async getOllamaEmbeddingsBatch(inputs: string[]): Promise<number[][]> {
    try {
      const data = JSON.stringify({
        model: this.plugin.settings.ragEmbeddingModel || "nomic-embed-text",
        input: inputs,
      });

      const res = await requestUrl({
        url: `${normalizeBaseUrl(this.plugin.settings.ollamaBaseUrl)}/api/embed`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: data,
        throw: false,
      });

      if (res.status === 200) {
        const json: unknown = res.json;
        const embeddingsUnknown = getRecordProp(json, "embeddings");
        const embeddingsArr = asArray(embeddingsUnknown);
        if (embeddingsArr && embeddingsArr.length === inputs.length) {
          const out: number[][] = [];
          for (const item of embeddingsArr) {
            const emb = asNumberArray(item);
            // A malformed vector: use the one-at-a-time path below rather than
            // returning fewer vectors than texts.
            if (!emb) throw new Error("Ollama returned a malformed embedding");
            out.push(emb);
          }
          return out;
        }
      }
    } catch (e: unknown) {
      this.plugin.debugWarn("Horme: Batch embed failed, falling back to sequential.", e);
      this.plugin.diagnosticService.report(
        "Embeddings",
        `Batch embed failed, falling back to sequential: ${errorToMessage(e)}`,
        "warning",
      );
    }

    // Fallback: sequential one-at-a-time, shortening chunks that are too long.
    // A chunk that still fails throws: the callers count the file as failed and
    // keep what they had. (A zero vector used to be stored instead, so a stopped
    // Ollama or a missing model "indexed" the whole vault with blank vectors that
    // were never re-embedded.)
    const results: number[][] = [];
    for (let i = 0; i < inputs.length; i++) {
      results.push(await this.getOllamaEmbeddingSafe(inputs[i]));
    }
    return results;
  }

  private async getOllamaEmbeddingSafe(text: string, attempt = 0): Promise<number[]> {
    const limits = [text.length, 800, 400, 200];
    const truncated = text.slice(0, limits[attempt] ?? 200);

    try {
      return await this.getOllamaEmbedding(truncated);
    } catch (e: unknown) {
      const msg = errorToMessage(e);
      const isContextError = msg.includes("context length") || msg.includes("400");
      if (isContextError && attempt < 3) {
        this.plugin.debugWarn(
          `Horme: Chunk too long (attempt ${attempt + 1}), retrying at ${limits[attempt + 1]} chars...`,
        );
        this.plugin.diagnosticService.report(
          "Embeddings",
          `Chunk too long (attempt ${attempt + 1}), retrying at ${limits[attempt + 1]} chars`,
          "warning",
        );
        return await this.getOllamaEmbeddingSafe(text, attempt + 1);
      }
      throw e;
    }
  }

  private async getOllamaEmbedding(text: string): Promise<number[]> {
    const defaultModel = this.plugin.settings.ragEmbeddingModel || "nomic-embed-text";
    const data = JSON.stringify({
      model: defaultModel,
      input: text,
    });

    const res = await requestUrl({
      url: `${normalizeBaseUrl(this.plugin.settings.ollamaBaseUrl)}/api/embed`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: data,
      throw: false,
    });

    if (res.status === 200) {
      const json: unknown = res.json;
      const embeddingsUnknown = getRecordProp(json, "embeddings");
      const embeddingsArr = asArray(embeddingsUnknown);
      if (embeddingsArr && embeddingsArr.length > 0) {
        const first = asNumberArray(embeddingsArr[0]);
        if (first) return first;
      }
      const embedding = asNumberArray(getRecordProp(json, "embedding"));
      if (embedding) return embedding;
      throw new Error("Ollama embed response missing embeddings");
    }

    if (res.status === 501) {
      const legacyRes = await requestUrl({
        url: `${normalizeBaseUrl(this.plugin.settings.ollamaBaseUrl)}/api/embeddings`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: defaultModel, prompt: text }),
        throw: false,
      });
      if (legacyRes.status === 200) {
        const json: unknown = legacyRes.json;
        const embedding = asNumberArray(getRecordProp(json, "embedding"));
        if (embedding) return embedding;
        throw new Error("Ollama legacy embedding response missing embedding");
      }
      throw new Error(`Ollama legacy embeddings error: ${legacyRes.status}`);
    }

    const errorDetail = typeof res.text === "string" ? res.text.slice(0, 300) : "";
    throw new Error(`Ollama embed error: ${res.status}${errorDetail ? ` - ${errorDetail}` : ""}`);
  }

  /** Cached embedding-model autodetection result for this session. */
  private lmStudioDetectedEmbeddingModel: string | null = null;

  /**
   * Resolves the LM Studio embedding model: the dedicated setting first, then
   * autodetection from /v1/models (embedding models cannot chat and chat
   * models cannot embed, so the chat model must never be used here).
   */
  private async resolveLmStudioEmbeddingModel(): Promise<string> {
    const configured = this.plugin.settings.lmStudioEmbeddingModel.trim();
    if (configured) return configured;
    if (this.lmStudioDetectedEmbeddingModel) return this.lmStudioDetectedEmbeddingModel;
    const res = await requestUrl({
      url: `${normalizeBaseUrl(this.plugin.settings.lmStudioUrl)}/v1/models`,
      throw: false,
    });
    if (res.status === 200) {
      const dataArr = asArray(getRecordProp(res.json as unknown, "data")) ?? [];
      const ids = dataArr.map((m) => getStringProp(m, "id")).filter((m): m is string => Boolean(m));
      const detected = ids.find((id) => /embed/i.test(id));
      if (detected) {
        this.lmStudioDetectedEmbeddingModel = detected;
        return detected;
      }
    }
    throw new Error(
      "No LM Studio embedding model found. Load one (e.g. text-embedding-nomic-embed-text-v1.5) or set it in Horme settings.",
    );
  }

  private async getLMStudioEmbeddingsBatch(inputs: string[]): Promise<number[][]> {
    try {
      const model = await this.resolveLmStudioEmbeddingModel();
      const res = await requestUrl({
        url: `${normalizeBaseUrl(this.plugin.settings.lmStudioUrl)}/v1/embeddings`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          input: inputs,
        }),
        throw: false,
      });
      if (res.status !== 200) throw new Error(`LM Studio Error: ${res.status} - ${res.text}`);
      const json: unknown = res.json;
      const dataArr = asArray(getRecordProp(json, "data"));
      if (!dataArr || dataArr.length !== inputs.length)
        throw new Error("LM Studio response data missing or length mismatch");

      const out: number[][] = [];
      for (const item of dataArr) {
        const embedding = asNumberArray(getRecordProp(item, "embedding"));
        if (!embedding) throw new Error("LM Studio item missing vector data");
        out.push(embedding);
      }
      return out;
    } catch (e: unknown) {
      throw new Error(`LM Studio Batch Embedding Failed: ${errorToMessage(e)}`);
    }
  }

  /** Cached llama.cpp embedding-model autodetection result for this session. */
  private llamaCppDetectedEmbeddingModel: string | null = null;

  /**
   * Resolves the llama.cpp embedding model: the dedicated setting first, then
   * autodetection from the embedding server's /v1/models. llama.cpp serves
   * embeddings from a separate llama-server started with --embedding
   * (llamaCppEmbeddingUrl), never from the chat server.
   */
  private async resolveLlamaCppEmbeddingModel(): Promise<string> {
    const configured = this.plugin.settings.llamaCppEmbeddingModel.trim();
    if (configured) return configured;
    if (this.llamaCppDetectedEmbeddingModel) return this.llamaCppDetectedEmbeddingModel;
    const res = await requestUrl({
      url: `${normalizeBaseUrl(this.plugin.settings.llamaCppEmbeddingUrl)}/v1/models`,
      throw: false,
    });
    if (res.status === 200) {
      const dataArr = asArray(getRecordProp(res.json as unknown, "data")) ?? [];
      const ids = dataArr.map((m) => getStringProp(m, "id")).filter((m): m is string => Boolean(m));
      // The embedding server usually serves only embedding models, so any
      // model it lists is usable; prefer one whose name says "embed".
      const detected = ids.find((id) => /embed/i.test(id)) ?? ids[0];
      if (detected) {
        this.llamaCppDetectedEmbeddingModel = detected;
        return detected;
      }
    }
    throw new Error(
      "No llama.cpp embedding model found. Start a llama-server with --embedding on the embedding URL, or set the model in Horme settings.",
    );
  }

  private async getLlamaCppEmbeddingsBatch(inputs: string[]): Promise<number[][]> {
    try {
      const model = await this.resolveLlamaCppEmbeddingModel();
      const res = await requestUrl({
        url: `${normalizeBaseUrl(this.plugin.settings.llamaCppEmbeddingUrl)}/v1/embeddings`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          input: inputs,
        }),
        // Without this requestUrl throws "status 500" and the server's reason is lost.
        throw: false,
      });
      if (res.status !== 200) throw new Error(`llama.cpp error: ${res.status} - ${res.text}`);
      const json: unknown = res.json;
      const dataArr = asArray(getRecordProp(json, "data"));
      if (!dataArr || dataArr.length !== inputs.length)
        throw new Error("llama.cpp response data missing or length mismatch");

      const out: number[][] = [];
      for (const item of dataArr) {
        const embedding = asNumberArray(getRecordProp(item, "embedding"));
        if (!embedding) throw new Error("llama.cpp item missing vector data");
        out.push(embedding);
      }
      return out;
    } catch (e: unknown) {
      throw new Error(`llama.cpp batch embedding failed: ${errorToMessage(e)}`);
    }
  }

  /**
   * Splits long text into overlapping chunks for better semantic retrieval.
   * Smart boundaries: respects sentence and word boundaries.
   */
  chunkText(text: string, chunkSize = 450, overlap = 80): string[] {
    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
      let end = Math.min(start + chunkSize, text.length);

      if (end < text.length) {
        const midpoint = start + Math.floor(chunkSize / 2);
        let foundBoundary = false;
        for (let i = end; i >= midpoint; i--) {
          const ch = text[i];
          if (
            (ch === "." || ch === "!" || ch === "?") &&
            (i + 1 >= text.length || text[i + 1] === " " || text[i + 1] === "\n")
          ) {
            end = i + 1;
            foundBoundary = true;
            break;
          }
        }

        if (!foundBoundary) {
          for (let i = end; i > start; i--) {
            if (text[i] === " " || text[i] === "\n") {
              end = i;
              break;
            }
          }
        }
      }

      const chunk = text.slice(start, end).trim();
      if (chunk.length > 0) chunks.push(chunk);

      if (end >= text.length) break;
      start = Math.max(start + 1, end - overlap);
    }
    return chunks;
  }

  /**
   * Splits long text into overlapping chunks and returns their character offsets.
   */
  chunkTextWithOffsets(
    text: string,
    chunkSize = 1000,
    overlap = 150,
  ): { text: string; start: number; end: number }[] {
    const chunks: { text: string; start: number; end: number }[] = [];
    let start = 0;

    while (start < text.length) {
      let end = Math.min(start + chunkSize, text.length);

      if (end < text.length) {
        const midpoint = start + Math.floor(chunkSize / 2);
        let foundBoundary = false;
        for (let i = end; i >= midpoint; i--) {
          const ch = text[i];
          if (
            (ch === "." || ch === "!" || ch === "?") &&
            (i + 1 >= text.length || text[i + 1] === " " || text[i + 1] === "\n")
          ) {
            end = i + 1;
            foundBoundary = true;
            break;
          }
        }
        if (!foundBoundary) {
          for (let i = end; i > start; i--) {
            if (text[i] === " " || text[i] === "\n") {
              end = i;
              break;
            }
          }
        }
      }

      const chunkText = text.slice(start, end).trim();
      if (chunkText.length > 0) chunks.push({ text: chunkText, start, end });
      if (end >= text.length) break;
      start = Math.max(start + 1, end - overlap);
    }
    return chunks;
  }
}
