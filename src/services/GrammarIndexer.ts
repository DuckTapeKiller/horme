import { TFile, Notice, TFolder, normalizePath } from "obsidian";
import HormePlugin from "../../main";
import {
  compressEmbedding,
  cosineSimilarityFloatInt8,
  decompressEmbeddingToInt8,
  getModelPrefixes,
  quantizeEmbeddingToInt8
} from "../utils/VectorUtils";
import { asArray, asNumberArray, errorToMessage, getRecordProp, getStringProp } from "../utils/TypeGuards";

export interface GrammarChunk {
  path: string;
  content: string;
  embedding: Int8Array | string; // Int8Array in memory, base64 string on disk
}


export class GrammarIndexer {
  private plugin: HormePlugin;
  public chunks: GrammarChunk[] = [];
  private indexPath: string;
  private indexedModel: string = "";

  constructor(plugin: HormePlugin) {
    this.plugin = plugin;
    // Explicitly place in the plugin folder so the user can find it
    const configDir = this.plugin.app.vault.configDir;
    this.indexPath = normalizePath(`${configDir}/plugins/${this.plugin.manifest.id}/Grammar Index/grammar_index.json`);
    console.log(`Horme Grammar: Initializing index at ${this.indexPath}`);
  }

  async loadIndex() {
    try {
      const adapter = this.plugin.app.vault.adapter;
      if (await adapter.exists(this.indexPath)) {
        const data = await adapter.read(this.indexPath);
        const parsed: unknown = JSON.parse(data);

        // Support both old (raw array) and new (object with model) formats
        const isNewFormat = !Array.isArray(parsed) && Boolean(getStringProp(parsed, "model"));
        const rawChunks = isNewFormat
          ? (asArray(getRecordProp(parsed, "chunks")) ?? [])
          : (Array.isArray(parsed) ? parsed : []);

        // Check model compatibility
        this.indexedModel = isNewFormat ? (getStringProp(parsed, "model") ?? "") : "";
        const currentModel = this.plugin.settings.ragEmbeddingModel;
        if (this.indexedModel && this.indexedModel !== currentModel) {
          console.log(`Horme Grammar: Model changed (${this.indexedModel} → ${currentModel}). Index cleared.`);
          this.chunks = [];
          this.indexedModel = currentModel;
          return;
        }

        // Decompress on load
        const chunks: GrammarChunk[] = [];
        for (const c of rawChunks) {
          const path = getStringProp(c, "path");
          const content = getStringProp(c, "content");
          if (!path || !content) continue;
          const embeddingUnknown = getRecordProp(c, "embedding");
          if (typeof embeddingUnknown === "string") {
            chunks.push({ path, content, embedding: decompressEmbeddingToInt8(embeddingUnknown) });
            continue;
          }
          const embeddingArr = asNumberArray(embeddingUnknown);
          if (embeddingArr) {
            chunks.push({ path, content, embedding: quantizeEmbeddingToInt8(embeddingArr) });
            continue;
          }
          chunks.push({ path, content, embedding: new Int8Array() });
        }
        this.chunks = chunks;
        
        console.log(`Horme: Loaded ${this.chunks.length} grammar vectors.`);
      } else {
        console.log("Horme Grammar: No index found. Use 'Rebuild Grammar Index' in settings.");
      }
    } catch (e: unknown) {
      this.plugin.diagnosticService.report("Grammar", `Failed to load index: ${errorToMessage(e)}`);
    }
  }

  async rebuildIndex() {
    const folderPath = this.plugin.settings.grammarFolderPath || "Gramática";
    const folder = this.plugin.app.vault.getAbstractFileByPath(folderPath);

    if (!folder || !(folder instanceof TFolder)) {
      console.warn(`Horme: Grammar folder "${folderPath}" not found.`);
      this.plugin.diagnosticService.report("Grammar", `Grammar folder "${folderPath}" not found.`, "warning");
      return;
    }

    new Notice("Horme: Generating Grammar Index (view progress in console)...");
    this.chunks = [];
    
    const files = this.getFilesRecursively(folder);
    let totalChunks = 0;
    let errorCount = 0;
    const { document: docPrefix } = getModelPrefixes(this.plugin.settings.ragEmbeddingModel);
    
    console.log(`Horme Grammar: Scanning ${files.length} files in "${folderPath}"...`);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      this.plugin.setIndexingStatus(`Grammar: ${i + 1}/${files.length}`);
      
      if (file.extension === "md") {
        console.log(`Horme Grammar: [${i + 1}/${files.length}] Processing ${file.path}`);
        const content = await this.plugin.app.vault.read(file);
        const chunks = this.plugin.embeddingService.chunkTextWithOffsets(content, 600, 100);
        const validChunks = chunks.filter(c => c.text.trim().length > 0);

        if (validChunks.length > 0) {
          // Batch embed with document prefix
          const embeddingTexts = validChunks.map(c => `${docPrefix}${file.basename}\n\n${c.text}`);

          try {
            const embeddings = await this.plugin.embeddingService.getEmbeddings(embeddingTexts);
            for (let j = 0; j < validChunks.length; j++) {
              totalChunks++;
              if (embeddings[j] && embeddings[j].length > 0) {
                this.chunks.push({
                  path: file.path,
                  content: validChunks[j].text,
                  embedding: quantizeEmbeddingToInt8(embeddings[j])
                });
              }
            }
          } catch (e: unknown) {
            errorCount += validChunks.length;
            this.plugin.diagnosticService.report("Grammar", `Failed to index ${file.path}: ${errorToMessage(e)}`, "warning");
          }
        }
      }
    }

    this.indexedModel = this.plugin.settings.ragEmbeddingModel;
    await this.saveIndex();
    
    this.plugin.setIndexingStatus(null);
    
    if (errorCount > 0) {
      new Notice(`⚠️ Grammar Index Built with ${errorCount} errors. Check console.`);
    } else {
      new Notice(`✅ Grammar Index Ready (${totalChunks} chunks).`);
    }
  }

  private async saveIndex() {
    try {
      const adapter = this.plugin.app.vault.adapter;
      const configDir = this.plugin.app.vault.configDir;
      const folderPathToMake = normalizePath(`${configDir}/plugins/${this.plugin.manifest.id}/Grammar Index`);
      if (!(await adapter.exists(folderPathToMake))) await adapter.mkdir(folderPathToMake);

      // Compress on save, store with model metadata
      const serialized = this.chunks.map(c => ({
        ...c,
        embedding: typeof c.embedding === "string" ? c.embedding : compressEmbedding(c.embedding)
      }));

      const data = JSON.stringify({
        model: this.plugin.settings.ragEmbeddingModel,
        chunks: serialized
      });
      await adapter.write(this.indexPath, data);
      
      console.log(`Horme Grammar: SUCCESS. Index saved to: ${this.indexPath}`);
    } catch (e: unknown) {
      this.plugin.diagnosticService.report("Grammar", `Failed to save index: ${errorToMessage(e)}`);
    }
  }

  async deleteIndex(): Promise<"deleted" | "missing"> {
    const adapter = this.plugin.app.vault.adapter;
    const hadInMemory = this.chunks.length > 0;
    const hadOnDisk = await adapter.exists(this.indexPath);

    this.chunks = [];
    this.indexedModel = "";

    try {
      if (hadOnDisk) {
        await adapter.remove(this.indexPath);
      }
      if (hadOnDisk || hadInMemory) {
        this.plugin.diagnosticService.report("Grammar", "Grammar index deleted by user.", "info");
        return "deleted";
      }
      this.plugin.diagnosticService.report("Grammar", "Delete requested, but no grammar index was found.", "info");
      return "missing";
    } catch (e: unknown) {
      this.plugin.diagnosticService.report("Grammar", `Failed to delete index: ${errorToMessage(e)}`);
      throw e instanceof Error ? e : new Error(errorToMessage(e));
    }
  }

  private getFilesRecursively(folder: TFolder): TFile[] {
    const files: TFile[] = [];
    for (const child of folder.children) {
      if (child instanceof TFile) files.push(child);
      else if (child instanceof TFolder) files.push(...this.getFilesRecursively(child));
    }
    return files;
  }

  async search(query: string): Promise<string[]> {
    if (this.chunks.length === 0) await this.loadIndex();
    if (this.chunks.length === 0) return [];

    try {
      // Use query prefix for asymmetric models
      const { query: qPrefix } = getModelPrefixes(this.plugin.settings.ragEmbeddingModel);
      const queryEmbedding = await this.plugin.embeddingService.getEmbedding(`${qPrefix}${query}`);
      
      // Cosine similarity ranking
      const scored = this.chunks.map(chunk => ({
        ...chunk,
        score: cosineSimilarityFloatInt8(
          queryEmbedding,
          typeof chunk.embedding === "string" ? decompressEmbeddingToInt8(chunk.embedding) : chunk.embedding
        )
      }));

      scored.sort((a, b) => b.score - a.score);
      
      return scored.slice(0, 3).map(s => `[Manual: ${s.path}] (Relevance: ${s.score.toFixed(2)})\n${s.content}`);
    } catch (e: unknown) {
      console.error("Grammar Search Error:", e);
      this.plugin.diagnosticService.report("Grammar", `Search failed: ${errorToMessage(e)}`);
      return [];
    }
  }
}
