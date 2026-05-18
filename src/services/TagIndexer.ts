import { Notice, normalizePath } from "obsidian";
import HormePlugin from "../../main";
import {
  compressEmbedding,
  cosineSimilarityFloatInt8,
  decompressEmbeddingToInt8,
  quantizeEmbeddingToInt8
} from "../utils/VectorUtils";
import { asArray, asNumberArray, errorToMessage, getRecordProp, getStringProp } from "../utils/TypeGuards";

interface TagEntry {
  tag: string;
  embedding: Int8Array | string; // Int8Array in memory, base64 string on disk
}

export class TagIndexer {
  private plugin: HormePlugin;
  private index: TagEntry[] = [];
  private isIndexing = false;
  
  get entryCount(): number {
    return this.index.length;
  }
  
  private indexPath: string;
  private indexedModel: string = "";

  constructor(plugin: HormePlugin) {
    this.plugin = plugin;
    const configDir = this.plugin.app.vault.configDir;
    this.indexPath = normalizePath(`${configDir}/plugins/${this.plugin.manifest.id}/Tags Index/tag-index.json`);
    void this.loadIndex();
  }

  async loadIndex() {
    try {
      const exists = await this.plugin.app.vault.adapter.exists(this.indexPath);
      if (exists) {
        const data = await this.plugin.app.vault.adapter.read(this.indexPath);
        const parsed: unknown = JSON.parse(data);

        // Check model compatibility
        this.indexedModel = getStringProp(parsed, "model") ?? "";
        const currentModel = this.plugin.settings.ragEmbeddingModel;
        if (this.indexedModel && this.indexedModel !== currentModel) {
          this.plugin.debugLog(`Horme Tags: Model changed (${this.indexedModel} → ${currentModel}). Index cleared.`);
          this.index = [];
          this.indexedModel = currentModel;
          return;
        }

        const entries = asArray(getRecordProp(parsed, "entries")) ?? [];
        
        // Decompress on load
        const next: TagEntry[] = [];
        for (const e of entries) {
          const tag = getStringProp(e, "tag");
          if (!tag) continue;
          const embeddingUnknown = getRecordProp(e, "embedding");
          if (typeof embeddingUnknown === "string") {
            next.push({ tag, embedding: decompressEmbeddingToInt8(embeddingUnknown) });
            continue;
          }
          const embeddingArr = asNumberArray(embeddingUnknown);
          if (embeddingArr) {
            next.push({ tag, embedding: quantizeEmbeddingToInt8(embeddingArr) });
            continue;
          }
          next.push({ tag, embedding: new Int8Array() });
        }
        this.index = next;
      }
    } catch (e: unknown) {
      this.plugin.diagnosticService.report("Tags", `Failed to load index: ${errorToMessage(e)}`);
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
        embedding: typeof e.embedding === "string" ? e.embedding : compressEmbedding(e.embedding)
      }));
      const data = JSON.stringify({
        model: this.plugin.settings.ragEmbeddingModel,
        entries: serializedEntries
      });
      await adapter.write(this.indexPath, data);
    } catch (e: unknown) {
      this.plugin.diagnosticService.report("Tags", `Failed to save index: ${errorToMessage(e)}`);
    }
  }

  async deleteIndex(): Promise<"deleted" | "missing"> {
    if (this.isIndexing) {
      new Notice("Horme: Please wait for tag indexing to finish.");
      throw new Error("Blocked by active indexing.");
    }

    const adapter = this.plugin.app.vault.adapter;
    const hadInMemory = this.index.length > 0;
    const hadOnDisk = await adapter.exists(this.indexPath);

    this.index = [];
    this.indexedModel = "";

    try {
      if (hadOnDisk) {
        await adapter.remove(this.indexPath);
      }
      if (hadOnDisk || hadInMemory) {
        this.plugin.diagnosticService.report("Tags", "Tag index deleted by user.", "info");
        return "deleted";
      }
      this.plugin.diagnosticService.report("Tags", "Delete requested, but no tag index was found.", "info");
      return "missing";
    } catch (e: unknown) {
      this.plugin.diagnosticService.report("Tags", `Failed to delete index: ${errorToMessage(e)}`);
      throw e instanceof Error ? e : new Error(errorToMessage(e));
    }
  }

  /**
   * Scans all unique tags in the vault and indexes them semantically.
   */
  async rebuildTagIndex() {
    if (this.isIndexing) {
      new Notice("Horme: Tag indexing is already in progress.");
      return;
    }
    this.isIndexing = true;

    try {
      this.plugin.setIndexingStatus("Indexing Tags...");
      
      // Get all unique tags from Obsidian's metadata cache
      const allTags = new Set<string>();
      const files = this.plugin.app.vault.getMarkdownFiles();
      
      const processFmTags = (raw: unknown) => {
        if (!raw) return;
        const arr = Array.isArray(raw) ? raw : [raw];
        for (const item of arr) {
          if (typeof item === "string") {
            item.split(",").forEach(t => {
              const cleaned = t.trim().replace(/^#/, "");
              if (cleaned) allTags.add(cleaned);
            });
          }
        }
      };

      for (const file of files) {
        const cache = this.plugin.app.metadataCache.getFileCache(file);
        if (!cache) continue;

        if (cache.tags && cache.tags.length > 0) {
          cache.tags.forEach(t => allTags.add(t.tag.replace(/^#/, "")));
        }
        
        if (cache.frontmatter) {
          processFmTags(cache.frontmatter.tags);
          processFmTags(cache.frontmatter.tag);
        }
      }

      const tagList = Array.from(allTags);
      this.plugin.debugLog(`Horme: Indexing ${tagList.length} unique tags...`);
      
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
              newIndex.push({ tag: batch[j], embedding: quantizeEmbeddingToInt8(embeddings[j]) });
            }
          }
        } catch (e: unknown) {
          this.plugin.diagnosticService.report("Tags", `Tag batch indexing failed: ${errorToMessage(e)}`, "warning");
        }
      }

      this.index = newIndex;
      this.indexedModel = this.plugin.settings.ragEmbeddingModel;
      await this.saveIndex();
      this.plugin.setIndexingStatus(null);
      new Notice(`✅ Tag Index Ready (${this.index.length} tags)`);
      this.plugin.debugLog("Horme: Tag index rebuilt successfully.");
    } finally {
      this.isIndexing = false;
    }
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
          ? decompressEmbeddingToInt8(entry.embedding)
          : entry.embedding;
        return {
          tag: entry.tag,
          score: cosineSimilarityFloatInt8(queryEmbedding, emb)
        };
      });

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, topN).map(s => s.tag);
    } catch (e: unknown) {
      console.error("Horme: Semantic tag search failed", e);
      this.plugin.diagnosticService.report("Tags", `Semantic search failed: ${errorToMessage(e)}`);
      return [];
    }
  }
}
