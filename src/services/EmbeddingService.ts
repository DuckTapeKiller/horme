import { requestUrl } from "obsidian";
import HormePlugin from "../../main";
import { asArray, asNumberArray, errorToMessage, getRecordProp, getStringProp } from "../utils/TypeGuards";
import { normalizeBaseUrl } from "../utils/normalizeBaseUrl";

export class EmbeddingService {
  private plugin: HormePlugin;

  constructor(plugin: HormePlugin) {
    this.plugin = plugin;
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
    const chatProvider = this.plugin.settings.aiProvider;
    const embedProvider = chatProvider === "ollama" || chatProvider === "lmstudio" ? chatProvider : "ollama";

    const BATCH_SIZE = 32;
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE).map((t) => t.replace(/\0/g, "").trim());

      if (embedProvider === "ollama") {
        const result = await this.getOllamaEmbeddingsBatch(batch);
        allEmbeddings.push(...result);
      } else if (embedProvider === "lmstudio") {
        const result = await this.getLMStudioEmbeddingsBatch(batch);
        allEmbeddings.push(...result);
      }
    }
    return allEmbeddings;
  }

  private async getOllamaEmbeddingsBatch(inputs: string[]): Promise<number[][]> {
    try {
      const data = JSON.stringify({
        model: this.plugin.settings.ragEmbeddingModel || "nomic-embed-text",
        input: inputs,
      });

      const res = await requestUrl({
        url: `${this.plugin.settings.ollamaBaseUrl}/api/embed`,
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
            if (!emb) return [];
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

    // Fallback: sequential one-at-a-time with dynamic dimension recovery
    const results: number[][] = [];
    let detectedDimension = 768; // Safe fallback base dimension

    for (let i = 0; i < inputs.length; i++) {
      try {
        const embedding = await this.getOllamaEmbeddingSafe(inputs[i]);
        results.push(embedding);
        if (embedding && embedding.length > 0) {
          detectedDimension = embedding.length; // Capture the real model dimensions dynamically
        }
      } catch {
        // Build zero-vector matching the exact dimension required by the running model
        results.push(new Array<number>(detectedDimension).fill(0));
      }
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
      url: `${this.plugin.settings.ollamaBaseUrl}/api/embed`,
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
        url: `${this.plugin.settings.ollamaBaseUrl}/api/embeddings`,
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
