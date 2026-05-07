import { requestUrl } from "obsidian";
import HormePlugin from "../../main";

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
    if (!this.plugin.isLocalProviderActive()) {
      throw new Error("Privacy Guard: Vault access blocked.");
    }

    const provider = this.plugin.settings.aiProvider;
    // Limit batch size to prevent hitting Ollama/LM Studio payload limits
    const BATCH_SIZE = 32;
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE).map(t => t.replace(/\0/g, "").trim().slice(0, 2000));
      
      if (provider === "ollama") {
        const result = await this.getOllamaEmbeddingsBatch(batch);
        allEmbeddings.push(...result);
      } else {
        // LM Studio batching
        for (const text of batch) {
          allEmbeddings.push(await this.getLMStudioEmbedding(text));
        }
      }
    }
    return allEmbeddings;
  }

  private async getOllamaEmbeddingsBatch(inputs: string[]): Promise<number[][]> {
    const results: number[][] = [];
    const MICRO_BATCH_SIZE = 8;

    for (let i = 0; i < inputs.length; i += MICRO_BATCH_SIZE) {
      const batch = inputs.slice(i, i + MICRO_BATCH_SIZE);
      const data = JSON.stringify({
        model: this.plugin.settings.ragEmbeddingModel || "all-minilm",
        input: batch
      });

      try {
        const res = await requestUrl({
          url: `${this.plugin.settings.ollamaBaseUrl}/api/embed`,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: data,
          throw: false
        });

        if (res.status === 200 && res.json.embeddings) {
          results.push(...res.json.embeddings);
          continue;
        }
      } catch (e) {}

      // Fallback for this micro-batch
      for (const input of batch) {
        results.push(await this.getOllamaEmbedding(input));
      }
    }
    return results;
  }

  private async getOllamaEmbedding(text: string): Promise<number[]> {
    const data = JSON.stringify({
      model: this.plugin.settings.ragEmbeddingModel || "all-minilm",
      input: text
    });

    // Try Obsidian's native requestUrl first
    try {
      const res = await requestUrl({
        url: `${this.plugin.settings.ollamaBaseUrl}/api/embed`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: data,
        throw: false
      });

      if (res.status === 200) {
        if (res.json.embeddings?.length > 0) return res.json.embeddings[0];
        if (res.json.embedding) return res.json.embedding;
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
          if (legacyRes.status === 200 && legacyRes.json.embedding) return legacyRes.json.embedding;
      }

      if (res.status !== 500 && res.status !== 403 && res.status !== 0) {
        let msg = `Ollama Error: ${res.status} (Model: ${this.plugin.settings.ragEmbeddingModel})`;
        try { const j = JSON.parse(res.text); if (j.error) msg += ` - ${j.error}`; } catch {}
        throw new Error(msg);
      }
    } catch (e) {
      if (e.message && !e.message.includes("500") && !e.message.includes("403")) throw e;
    }

    // Fallback to Node.js
    return new Promise((resolve, reject) => {
      let url: URL;
      try { url = new URL(this.plugin.settings.ollamaBaseUrl); } catch (e) { url = new URL("http://127.0.0.1:11434"); }

      const isHttps = url.protocol === "https:";
      const http = isHttps ? require("https") : require("http");
      
      const options = {
        hostname: url.hostname === "localhost" ? "127.0.0.1" : url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: "/api/embed",
        method: "POST",
        headers: {
          "Host": url.host,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          "User-Agent": "curl/7.64.1"
        },
        timeout: 15000
      };

      const req = http.request(options, (res: any) => {
        let responseBody = "";
        res.on("data", (chunk: any) => responseBody += chunk);
        res.on("end", () => {
          if (res.statusCode === 501) {
              // Try legacy path in Node too
              const legacyData = JSON.stringify({ model: this.plugin.settings.ragEmbeddingModel, prompt: text });
              const legacyOptions = { ...options, path: "/api/embeddings", headers: { ...options.headers, "Content-Length": Buffer.byteLength(legacyData) } };
              const legacyReq = http.request(legacyOptions, (lres: any) => {
                  let lbody = "";
                  lres.on("data", (c: any) => lbody += c);
                  lres.on("end", () => {
                      if (lres.statusCode === 200) {
                          try { const p = JSON.parse(lbody); if (p.embedding) resolve(p.embedding); else reject(new Error("No legacy embedding")); } catch (e) { reject(e); }
                      } else { reject(new Error(`Ollama 501 & Legacy ${lres.statusCode} (Model: ${this.plugin.settings.ragEmbeddingModel})`)); }
                  });
              });
              legacyReq.on("error", (e: any) => reject(e));
              legacyReq.write(legacyData);
              legacyReq.end();
              return;
          }

          if (res.statusCode !== 200) {
            let msg = `Ollama Error: ${res.statusCode} (Model: ${this.plugin.settings.ragEmbeddingModel})`;
            try { const j = JSON.parse(responseBody); if (j.error) msg += ` - ${j.error}`; } catch {}
            reject(new Error(msg));
            return;
          }
          try {
            const parsed = JSON.parse(responseBody);
            if (parsed.embeddings?.length > 0) resolve(parsed.embeddings[0]);
            else if (parsed.embedding) resolve(parsed.embedding);
            else reject(new Error("No embedding in response"));
          } catch (e) { reject(e); }
        });
      });

      req.on("error", (e: any) => {
        if (e.code === "ECONNREFUSED") reject(new Error("Ollama connection refused. Is Ollama running?"));
        else if (e.code === "ETIMEDOUT") reject(new Error("Ollama connection timed out. Server might be busy."));
        else reject(e);
      });
      
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Ollama request timed out after 15s"));
      });

      req.write(data);
      req.end();
    });
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
      return res.json.data[0].embedding;
    } catch (e) {
      throw new Error(`LM Studio Embedding Failed: ${e.message || e}`);
    }
  }

  /**
   * Splits long text into overlapping chunks for better semantic retrieval.
   * Smart boundaries: respects sentence and word boundaries.
   */
  chunkText(text: string, chunkSize = 500, overlap = 100): string[] {
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
    chunkSize = 500,
    overlap = 100
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
      start = Math.max(start + 1, end - overlap);
    }

    return chunks;
  }
}
