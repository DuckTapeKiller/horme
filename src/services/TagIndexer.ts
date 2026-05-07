import { App, normalizePath, TFile } from "obsidian";
import HormePlugin from "../../main";

interface TagEntry {
  tag: string;
  embedding: number[];
}

export class TagIndexer {
  private plugin: HormePlugin;
  private index: TagEntry[] = [];
  private indexPath: string;

  constructor(plugin: HormePlugin) {
    this.plugin = plugin;
    const configDir = this.plugin.app.vault.configDir;
    this.indexPath = normalizePath(`${configDir}/plugins/${this.plugin.manifest.id}/tag-index.json`);
    this.loadIndex();
  }

  async loadIndex() {
    try {
      const exists = await this.plugin.app.vault.adapter.exists(this.indexPath);
      if (exists) {
        const data = await this.plugin.app.vault.adapter.read(this.indexPath);
        const parsed = JSON.parse(data);
        this.index = parsed.entries || [];
      }
    } catch (e) {
      console.error("Horme: Failed to load tag index", e);
    }
  }

  async saveIndex() {
    try {
      const data = JSON.stringify({ entries: this.index });
      await this.plugin.app.vault.adapter.write(this.indexPath, data);
    } catch (e) {
      console.error("Horme: Failed to save tag index", e);
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
      this.plugin.setIndexingStatus(`Indexing Tags (${i}/${tagList.length})`);
      
      try {
        const embeddings = await this.plugin.embeddingService.getEmbeddings(batch);
        for (let j = 0; j < batch.length; j++) {
          if (embeddings[j]) {
            const rounded = embeddings[j].map(n => Math.round(n * 10000) / 10000);
            newIndex.push({ tag: batch[j], embedding: rounded });
          }
        }
      } catch (e) {
        console.error(`Horme: Failed to index tag batch starting at ${i}`, e);
      }
    }

    this.index = newIndex;
    await this.saveIndex();
    this.plugin.setIndexingStatus(null);
    console.log("Horme: Tag index rebuilt successfully.");
  }

  /**
   * Finds the top N tags most semantically similar to the provided text.
   */
  async getSemanticCandidates(text: string, topN = 50): Promise<string[]> {
    if (this.index.length === 0) return [];

    try {
      // Use 1,500 characters for a better semantic overview
      const queryEmbedding = await this.plugin.embeddingService.getEmbedding(text.slice(0, 1500));
      
      const scored = this.index.map(entry => ({
        tag: entry.tag,
        score: this.cosineSimilarity(queryEmbedding, entry.embedding)
      }));

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, topN).map(s => s.tag);
    } catch (e) {
      console.error("Horme: Semantic tag search failed", e);
      return [];
    }
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    const len = Math.min(a.length, b.length);
    if (len === 0) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < len; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }
}
