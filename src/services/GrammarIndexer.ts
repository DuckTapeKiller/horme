import { TFile, Notice, TFolder, normalizePath } from "obsidian";
import HormePlugin from "../../main";
import { compressEmbedding, decompressEmbedding, cosineSimilarity, getModelPrefixes } from "../utils/VectorUtils";

export interface GrammarChunk {
  path: string;
  content: string;
  embedding: number[] | string; // number[] in memory, string (base64 int8) on disk
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
        const parsed = JSON.parse(data);

        // Support both old (raw array) and new (object with model) formats
        const isNewFormat = !Array.isArray(parsed) && parsed.model;
        const rawChunks = isNewFormat ? parsed.chunks : (Array.isArray(parsed) ? parsed : []);

        // Check model compatibility
        this.indexedModel = isNewFormat ? parsed.model : "";
        const currentModel = this.plugin.settings.ragEmbeddingModel;
        if (this.indexedModel && this.indexedModel !== currentModel) {
          console.log(`Horme Grammar: Model changed (${this.indexedModel} → ${currentModel}). Index cleared.`);
          this.chunks = [];
          this.indexedModel = currentModel;
          return;
        }

        // Decompress on load
        this.chunks = rawChunks.map((c: any) => ({
          ...c,
          embedding: typeof c.embedding === "string" ? decompressEmbedding(c.embedding) : c.embedding
        }));
        
        console.log(`Horme: Loaded ${this.chunks.length} grammar vectors.`);
      } else {
        console.log("Horme Grammar: No index found. Use 'Rebuild Grammar Index' in settings.");
      }
    } catch (e) {
      this.plugin.diagnosticService.report("Grammar", `Failed to load index: ${e.message}`);
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
                  embedding: embeddings[j]
                });
              }
            }
          } catch (e) {
            errorCount += validChunks.length;
            this.plugin.diagnosticService.report("Grammar", `Failed to index ${file.path}: ${e.message}`, "warning");
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
        embedding: typeof c.embedding === "string" ? c.embedding : compressEmbedding(c.embedding as number[])
      }));

      const data = JSON.stringify({
        model: this.plugin.settings.ragEmbeddingModel,
        chunks: serialized
      });
      await adapter.write(this.indexPath, data);
      
      console.log(`Horme Grammar: SUCCESS. Index saved to: ${this.indexPath}`);
    } catch (e) {
      this.plugin.diagnosticService.report("Grammar", `Failed to save index: ${e.message}`);
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
        score: cosineSimilarity(queryEmbedding, chunk.embedding as number[])
      }));

      scored.sort((a, b) => b.score - a.score);
      
      return scored.slice(0, 3).map(s => `[Manual: ${s.path}] (Relevance: ${s.score.toFixed(2)})\n${s.content}`);
    } catch (e: any) {
      console.error("Grammar Search Error:", this.plugin.diagnosticService.sanitizeText(e?.message || String(e)));
      this.plugin.diagnosticService.report("Grammar", `Search failed: ${e.message}`);
      return [];
    }
  }
}
