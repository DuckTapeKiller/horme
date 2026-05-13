import { requestUrl } from "obsidian";
import HormePlugin from "../../main";
import { asArray, asNumberArray, errorToMessage, getRecordProp } from "../utils/TypeGuards";

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
    // For cloud providers, we MUST use a local provider for embeddings (default to Ollama)
    const embedProvider = (chatProvider === "ollama" || chatProvider === "lmstudio") 
      ? chatProvider 
      : "ollama";

    const BATCH_SIZE = 32;
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE).map(t => t.replace(/\0/g, "").trim());
      
      if (embedProvider === "ollama") {
        const result = await this.getOllamaEmbeddingsBatch(batch);
        allEmbeddings.push(...result);
      } else if (embedProvider === "lmstudio") {
        for (const text of batch) {
          allEmbeddings.push(await this.getLMStudioEmbedding(text));
        }
      }
    }
    return allEmbeddings;
  }

  private async getOllamaEmbeddingsBatch(inputs: string[]): Promise<number[][]> {
    // Try true batch request first (Ollama supports array `input`)
    try {
      const data = JSON.stringify({
        model: this.plugin.settings.ragEmbeddingModel || "nomic-embed-text",
        input: inputs
      });

      const res = await requestUrl({
        url: `${this.plugin.settings.ollamaBaseUrl}/api/embed`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: data,
        throw: false
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
      console.warn("Horme: Batch embed failed, falling back to sequential.", e);
      this.plugin.diagnosticService.report("Embeddings", `Batch embed failed, falling back to sequential: ${errorToMessage(e)}`, "warning");
    }

    // Fallback: sequential one-at-a-time
    const results: number[][] = [];
    for (let i = 0; i < inputs.length; i++) {
      try {
        const embedding = await this.getOllamaEmbeddingSafe(inputs[i]);
        results.push(embedding);
      } catch (e: unknown) {
        results.push(new Array(1024).fill(0)); // zero vector = excluded by MIN_SIMILARITY
      }
    }
    return results;
  }

  private async getOllamaEmbeddingSafe(text: string, attempt = 0): Promise<number[]> {
    // On retry, truncate progressively: full → 800 → 400 → 200
    const limits = [text.length, 800, 400, 200];
    const truncated = text.slice(0, limits[attempt] ?? 200);

    try {
      return await this.getOllamaEmbedding(truncated);
    } catch (e: unknown) {
      const msg = errorToMessage(e);
      const isContextError = msg.includes("context length") || msg.includes("400");
      if (isContextError && attempt < 3) {
        console.warn(`Horme: Chunk too long (attempt ${attempt + 1}), retrying at ${limits[attempt + 1]} chars...`);
        this.plugin.diagnosticService.report("Embeddings", `Chunk too long (attempt ${attempt + 1}), retrying at ${limits[attempt + 1]} chars`, "warning");
        return await this.getOllamaEmbeddingSafe(text, attempt + 1);
      }
      throw e;
    }
  }

  private async getOllamaEmbedding(text: string): Promise<number[]> {
    const data = JSON.stringify({
      model: this.plugin.settings.ragEmbeddingModel || "nomic-embed-text",
      input: text
    });

    const res = await requestUrl({
      url: `${this.plugin.settings.ollamaBaseUrl}/api/embed`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: data,
      throw: false
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

    // If 501, try the legacy /api/embeddings endpoint
    if (res.status === 501) {
      const legacyRes = await requestUrl({
        url: `${this.plugin.settings.ollamaBaseUrl}/api/embeddings`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.plugin.settings.ragEmbeddingModel, prompt: text }),
        throw: false
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

  private async getLMStudioEmbedding(text: string): Promise<number[]> {
    try {
      const res = await requestUrl({
        url: `${this.plugin.settings.lmStudioUrl}/v1/embeddings`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.plugin.settings.lmStudioModel || "local-model",
          input: text
        })
      });
      if (res.status !== 200) throw new Error(`LM Studio Error: ${res.status} - ${res.text}`);
      const json: unknown = res.json;
      const dataArr = asArray(getRecordProp(json, "data"));
      if (!dataArr || dataArr.length === 0) throw new Error("LM Studio response missing data");
      const first = dataArr[0];
      const embedding = asNumberArray(getRecordProp(first, "embedding"));
      if (!embedding) throw new Error("LM Studio response missing embedding");
      return embedding;
    } catch (e: unknown) {
      throw new Error(`LM Studio Embedding Failed: ${errorToMessage(e)}`);
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

        // Search backward from end for a sentence boundary in the second half of the chunk
        let foundBoundary = false;
        for (let i = end; i >= midpoint; i--) {
          const ch = text[i];
          if ((ch === "." || ch === "!" || ch === "?") &&
              (i + 1 >= text.length || text[i + 1] === " " || text[i + 1] === "\n")) {
            end = i + 1;
            foundBoundary = true;
            break;
          }
        }

        // Fall back to word boundary if no sentence boundary found
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

      // Always advance forward — never go backward
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
    overlap = 150
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

      // Always advance forward — never go backward
      start = Math.max(start + 1, end - overlap);
    }

    return chunks;
  }
}
