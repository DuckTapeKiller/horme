import { Notice, normalizePath } from "obsidian";
import HormePlugin from "../../main";
import { compressEmbedding, decompressEmbedding, cosineSimilarity } from "../utils/VectorUtils";

interface TagEntry {
  tag: string;
  embedding: number[] | string; // number[] in memory, string (base64 int8) on disk
}

export class TagIndexer {
  private plugin: HormePlugin;
  private index: TagEntry[] = [];
  
  get entryCount(): number {
    return this.index.length;
  }
  
  private indexPath: string;
  private indexedModel: string = "";

  constructor(plugin: HormePlugin) {
    this.plugin = plugin;
    const configDir = this.plugin.app.vault.configDir;
    this.indexPath = normalizePath(`${configDir}/plugins/${this.plugin.manifest.id}/Tags Index/tag-index.json`);
    this.loadIndex();
  }

  async loadIndex() {
    try {
      const exists = await this.plugin.app.vault.adapter.exists(this.indexPath);
      if (exists) {
        const data = await this.plugin.app.vault.adapter.read(this.indexPath);
        const parsed = JSON.parse(data);

        // Check model compatibility
        this.indexedModel = parsed.model || "";
        const currentModel = this.plugin.settings.ragEmbeddingModel;
        if (this.indexedModel && this.indexedModel !== currentModel) {
          console.log(`Horme Tags: Model changed (${this.indexedModel} → ${currentModel}). Index cleared.`);
          this.index = [];
          this.indexedModel = currentModel;
          return;
        }

        const entries = parsed.entries || [];
        
        // Decompress on load
        this.index = entries.map((e: any) => ({
          tag: e.tag,
          embedding: typeof e.embedding === "string" ? decompressEmbedding(e.embedding) : e.embedding
        }));
      }
    } catch (e) {
      this.plugin.diagnosticService.report("Tags", `Failed to load index: ${e.message}`);
    }
  }

  async saveIndex() {
    try {
      const adapter = this.plugin.app.vault.adapter;
      const configDir = this.plugin.app.vault.configDir;
      const folderPath = normalizePath(`${configDir}/plugins/${this.plugin.manifest.id}/Tags Index`);
      if (!(await adapter.exists(folderPath))) await adapter.mkdir(folderPath);

      const serializedEntries = this.index.map(e => ({
        tag: e.tag,
        embedding: typeof e.embedding === "string" ? e.embedding : compressEmbedding(e.embedding as number[])
      }));
      const data = JSON.stringify({
        model: this.plugin.settings.ragEmbeddingModel,
        entries: serializedEntries
      });
      await adapter.write(this.indexPath, data);
    } catch (e) {
      this.plugin.diagnosticService.report("Tags", `Failed to save index: ${e.message}`);
    }
  }

  /**
   * Scans all unique tags in the vault and indexes them semantically.
   */
  async rebuildTagIndex() {
    this.plugin.setIndexingStatus("Indexing Tags...");
    
    // Get all unique tags from Obsidian's metadata cache
    const allTags = new Set<string>();
    const files = this.plugin.app.vault.getMarkdownFiles();
    
    for (const file of files) {
      const cache = this.plugin.app.metadataCache.getFileCache(file);
      if (cache?.tags) {
        cache.tags.forEach(t => allTags.add(t.tag.startsWith("#") ? t.tag.slice(1) : t.tag));
      }
      // Also check frontmatter tags
      if (cache?.frontmatter?.tags) {
        const fmTags = Array.isArray(cache.frontmatter.tags) ? cache.frontmatter.tags : [cache.frontmatter.tags];
        fmTags.forEach((t: any) => {
           if (typeof t === "string") allTags.add(t.startsWith("#") ? t.slice(1) : t);
        });
      }
    }

    const tagList = Array.from(allTags);
    console.log(`Horme: Indexing ${tagList.length} unique tags...`);
    
    const newIndex: TagEntry[] = [];

    
    // Process in batches for speed
    const BATCH_SIZE = 50;
    for (let i = 0; i < tagList.length; i += BATCH_SIZE) {
      const batch = tagList.slice(i, i + BATCH_SIZE);
      this.plugin.setIndexingStatus(`Tags: ${i}/${tagList.length}`);
      
      try {
        // No prefix: tag suggestion is symmetric (tag text ↔ note content)
        const humanizedBatch = batch.map(t => t.replace(/[/_]/g, " "));
        const embeddings = await this.plugin.embeddingService.getEmbeddings(humanizedBatch);
        for (let j = 0; j < batch.length; j++) {
          if (embeddings[j] && embeddings[j].length > 0) {
            newIndex.push({ tag: batch[j], embedding: compressEmbedding(embeddings[j]) });
          }
        }
      } catch (e) {
        this.plugin.diagnosticService.report("Tags", `Tag batch indexing failed: ${e.message}`, "warning");
      }
    }

    this.index = newIndex;
    this.indexedModel = this.plugin.settings.ragEmbeddingModel;
    await this.saveIndex();
    this.plugin.setIndexingStatus(null);
    new Notice(`✅ Tag Index Ready (${this.index.length} tags)`);
    console.log("Horme: Tag index rebuilt successfully.");
  }

  /**
   * Finds the top N tags most semantically similar to the provided text.
   */
  async getSemanticCandidates(text: string, topN = 50): Promise<string[]> {
    if (this.index.length === 0) return [];

    try {
      // Note: No isLocalProviderActive() guard here because EmbeddingService 
      // always routes embeddings to Ollama, even when the chat provider is cloud.
      // This ensures tag suggestions work without leaking data to the cloud.
      const queryEmbedding = await this.plugin.embeddingService.getEmbedding(
        text.slice(0, 1500)
      );
      
      const scored = this.index.map(entry => {
        const emb = typeof entry.embedding === "string" 
          ? decompressEmbedding(entry.embedding) 
          : entry.embedding;
        return {
          tag: entry.tag,
          score: cosineSimilarity(queryEmbedding, emb as number[])
        };
      });

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, topN).map(s => s.tag);
    } catch (e: any) {
      console.error("Horme: Semantic tag search failed", this.plugin.diagnosticService.sanitizeText(e?.message || String(e)));
      this.plugin.diagnosticService.report("Tags", `Semantic search failed: ${e.message}`);
      return [];
    }
  }
}
