import { TFile, Notice, normalizePath } from "obsidian";
import HormePlugin from "../../main";

interface IndexEntry {
  path: string;
  chunkStart: number;
  chunkEnd: number;
  embedding: number[];
  mtime: number;
  model: string;
}

export class VaultIndexer {
  private plugin: HormePlugin;
  private index: IndexEntry[] = [];
  private indexedModel: string = "";
  private indexPath: string;

  constructor(plugin: HormePlugin) {
    this.plugin = plugin;
    // Explicitly resolve the plugin directory relative to the vault root
    const configDir = this.plugin.app.vault.configDir;
    this.indexPath = normalizePath(`${configDir}/plugins/${this.plugin.manifest.id}/vault-index.json`);
    console.log(`Horme Brain: Initializing index at ${this.indexPath}`);
    this.loadIndex();

    // Wipe index if embedding model changes while plugin is running
    this.plugin.onSettingsChange(() => {
      const current = this.plugin.settings.ragEmbeddingModel;
      if (this.indexedModel && this.indexedModel !== current) {
        console.log(`Horme Brain: Model changed to ${current}. Clearing in-memory index.`);
        this.index = [];
        this.indexedModel = current;
        new Notice("Vault Brain: Embedding model changed. Index cleared — please rebuild.");
      }
    });
  }

  private async loadIndex() {
    try {
      const exists = await this.plugin.app.vault.adapter.exists(this.indexPath);
      if (exists) {
        const data = await this.plugin.app.vault.adapter.read(this.indexPath);
        const parsed = JSON.parse(data);
        
        // Support both old flat array format and new wrapped format
        if (Array.isArray(parsed)) {
          // Old format — treat as stale, wipe it
          console.log("Horme Brain: Old index format detected. Will rebuild.");
          this.index = [];
          this.indexedModel = "";
        } else {
          this.indexedModel = parsed.model || "";
          this.index = parsed.entries || [];
          const currentModel = this.plugin.settings.ragEmbeddingModel;
          if (this.indexedModel !== currentModel) {
            console.log(`Horme Brain: Embedding model changed (${this.indexedModel} → ${currentModel}). Wiping index.`);
            this.index = [];
            this.indexedModel = currentModel;
          } else {
            console.log(`Horme Brain: Loaded ${this.index.length} entries (model: ${this.indexedModel}).`);
          }
        }
      } else {
        console.log("Horme Brain: No existing index found.");
      }
    } catch (e) {
      console.error("Horme Brain: Failed to load vault index", e);
    }
  }

  private async saveIndex() {
    try {
      const currentModel = this.plugin.settings.ragEmbeddingModel;
      const data = JSON.stringify({ model: currentModel, entries: this.index });
      await this.plugin.app.vault.adapter.write(this.indexPath, data);
      this.indexedModel = currentModel;
    } catch (e) {
      console.error("Horme Brain: Critical failure saving index", e);
      new Notice(`Vault Brain: Failed to save index file! ${e.message}`);
    }
  }

  private isIndexing = false;

  /**
   * Rebuilds the index incrementally.
   */
  async rebuildIndex() {
    if (this.isIndexing) {
        new Notice("Vault Brain: Indexing is already in progress.");
        return;
    }
    this.isIndexing = true;
    
    try {
      if (!this.plugin.isLocalProviderActive()) {
        new Notice("Vault Brain: Privacy lock active. Indexing aborted.");
        return;
      }
      if (!this.plugin.settings.vaultBrainEnabled) {
        new Notice("Vault Brain: Vault Brain is disabled in settings.");
        return;
      }

    const files = this.plugin.app.vault.getMarkdownFiles();
    const total = files.length;
    console.log(`Horme Brain: Rebuilding index for ${total} files...`);
    let updatedCount = 0;
    let errorCount = 0;
    
    this.plugin.settings.indexStatus = `Indexing (0/${total})...`;
    this.plugin.saveSettings();
    this.plugin.setIndexingStatus(`Indexing 0 / ${total}`);

    for (let i = 0; i < total; i++) {
      const file = files[i];
      if (i % 5 === 0) {
        this.plugin.settings.indexStatus = `Indexing (${i + 1}/${total}): ${file.name.slice(0, 20)}...`;
        this.plugin.setIndexingStatus(`Indexing ${i + 1} / ${total}`);
      }
      
      const existing = this.index.filter(e => e.path === file.path);
      if (existing.length > 0 && existing[0].mtime >= file.stat.mtime) {
        continue;
      }

      this.index = this.index.filter(e => e.path !== file.path);

      try {
        const content = await this.plugin.app.vault.read(file);
        if (!content.trim()) continue;

        const chunksWithOffsets = this.plugin.embeddingService.chunkTextWithOffsets(content);
        const validChunks = chunksWithOffsets.filter(c => c.text.trim().length > 0);
        
        if (validChunks.length > 0) {
          const embeddings = await this.plugin.embeddingService.getEmbeddings(
            validChunks.map(c => c.text)
          );
          for (let j = 0; j < validChunks.length; j++) {
            if (embeddings[j] && embeddings[j].length > 0) {
              const rounded = embeddings[j].map(n => Math.round(n * 10000) / 10000);
              this.index.push({
                path: file.path,
                chunkStart: validChunks[j].start,
                chunkEnd: validChunks[j].end,
                embedding: rounded,
                mtime: file.stat.mtime,
                model: this.plugin.settings.ragEmbeddingModel
              });
            }
          }
        }
        updatedCount++;
      } catch (e) {
        console.error(`Horme: Failed to index ${file.path}`, e);
        errorCount++;
        // Keep going unless we hit a massive amount of errors
        if (errorCount > 50) {
          new Notice(`Vault Brain: Too many errors (${errorCount}). Indexing paused.`);
          this.plugin.settings.indexStatus = "Failed (too many errors)";
          await this.plugin.saveSettings();
          return;
        }
      }
    }

    await this.saveIndex();
    this.plugin.settings.indexStatus = "Ready";
    await this.plugin.saveSettings();
    this.plugin.setIndexingStatus(null);
    
    if (errorCount > 0) {
      new Notice(`Vault Brain: Indexed ${updatedCount} files. (${errorCount} failed - check console)`);
    } else {
      new Notice(`Vault Brain: Successfully indexed ${updatedCount} files.`);
    }
  } catch (e) {
    console.error("Horme Brain: Fatal error during rebuild", e);
    new Notice("Vault Brain: Indexing failed fatally.");
  } finally {
    this.isIndexing = false;
  }
}

  private indexingQueue: TFile[] = [];
  private isProcessingQueue = false;

  /**
   * Enqueues a file for indexing.
   */
  async enqueueIndex(file: TFile) {
    if (!this.plugin.isLocalProviderActive() || !this.plugin.settings.vaultBrainEnabled) {
      console.log(`Horme Brain: Enqueue skipped for ${file.path} (Privacy Guard or Disabled)`);
      return;
    }
    
    console.log(`Horme Brain: Enqueueing ${file.path} for indexing...`);
    if (!this.indexingQueue.some(f => f.path === file.path)) {
      this.indexingQueue.push(file);
    }
    this.processQueue();
  }

  private async processQueue() {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    while (this.indexingQueue.length > 0) {
      // Re-check on every iteration — provider may have changed since enqueue
      if (!this.plugin.isLocalProviderActive() || !this.plugin.settings.vaultBrainEnabled) {
        console.log("Horme Brain: Provider changed during queue processing. Clearing queue.");
        this.indexingQueue = [];
        break;
      }
      const file = this.indexingQueue.shift();
      if (file) {
        await this.indexFile(file);
        // Small breathing room between files to prevent UI/network saturation
        await new Promise(r => setTimeout(r, 100));
      }
    }

    this.isProcessingQueue = false;
  }

  /**
   * Indexes a single file (Internal use by queue or rebuild).
   */
  private async indexFile(file: TFile) {
    // Remove old entries
    this.index = this.index.filter(e => e.path !== file.path);

    try {
      const content = await this.plugin.app.vault.read(file);
      if (!content.trim()) return;

      const chunksWithOffsets = this.plugin.embeddingService.chunkTextWithOffsets(content);
      const validChunks = chunksWithOffsets.filter(c => c.text.trim().length > 0);
      
      if (validChunks.length > 0) {
        const embeddings = await this.plugin.embeddingService.getEmbeddings(
          validChunks.map(c => c.text)
        );
        for (let j = 0; j < validChunks.length; j++) {
          if (embeddings[j] && embeddings[j].length > 0) {
            this.index.push({
              path: file.path,
              chunkStart: validChunks[j].start,
              chunkEnd: validChunks[j].end,
              embedding: embeddings[j],
              mtime: file.stat.mtime,
              model: this.plugin.settings.ragEmbeddingModel
            });
          }
        }
        await this.saveIndex();
      }
    } catch (e) {
      console.error(`Horme: Failed to index ${file.path}`, e);
    }
  }

  /**
   * Finds the most relevant chunks using Cosine Similarity.
   */
  async search(query: string, topN = 5): Promise<string[]> {
    if (!this.plugin.isLocalProviderActive() || !this.plugin.settings.vaultBrainEnabled) {
      return [];
    }

    try {
      const queryEmbedding = await this.plugin.embeddingService.getEmbedding(query);
      const MIN_SIMILARITY = 0.35;

      const scored = this.index
        .map(entry => ({
          entry,
          score: this.cosineSimilarity(queryEmbedding, entry.embedding)
        }))
        .filter(s => s.score >= MIN_SIMILARITY)
        .sort((a, b) => b.score - a.score)
        .slice(0, topN);

      const results: string[] = [];
      for (const { entry } of scored) {
        try {
          const abstractFile = this.plugin.app.vault.getAbstractFileByPath(entry.path);
          if (!(abstractFile instanceof TFile)) continue;
          if (abstractFile.stat.mtime > entry.mtime) continue; // stale, skip
          const content = await this.plugin.app.vault.read(abstractFile);
          const chunk = content.slice(entry.chunkStart, entry.chunkEnd).trim();
          if (chunk) results.push(`[From ${entry.path}]:\n${chunk}`);
        } catch {
          // File deleted or unreadable — skip silently
        }
      }

      return results;
    } catch (e) {
      console.error("Horme: Search failed", e);
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
