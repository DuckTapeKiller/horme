import { TFile, Notice, normalizePath } from "obsidian";
import HormePlugin from "../../main";
import { HormeErrorModal } from "../modals/HormeErrorModal";
import { compressEmbedding, decompressEmbedding, cosineSimilarity, getModelPrefixes } from "../utils/VectorUtils";

interface IndexEntry {
  path: string;
  chunkStart: number;
  chunkEnd: number;
  embedding: number[] | string;
  mtime: number;
  summaryText?: string;
  tagsText?: string;
  headingPath?: string;
}


const STOP_WORDS = new Set([
  "ayúdame", "encontrar", "podrías", "busca", "encuentra", "dime", "sobre", "háblame", "tienes", "algo", "artículo", "nota", "notas", "vault", "bóveda", "mi", "mis",
  "the", "and", "for", "with", "from", "that", "this", "these", "those", "about", "find", "help", "note", "search",
  "un", "una", "unos", "unas", "el", "la", "los", "las", "en", "con", "por", "para", "que", "del", "al"
]);

export class VaultIndexer {
  private plugin: HormePlugin;
  public index: IndexEntry[] = [];
  private pathIndex: Map<string, IndexEntry[]> = new Map();
  public indexedModel: string = "";
  private indexPath: string;

  /** O(1) lookup of entries by path */
  private getEntriesForPath(path: string): IndexEntry[] {
    return this.pathIndex.get(path) || [];
  }

  /** Removes all entries for a given path from both the flat array and the Map */
  private removeEntriesForPath(path: string): void {
    const existing = this.pathIndex.get(path);
    if (!existing || existing.length === 0) return;
    const pathSet = new Set(existing);
    this.index = this.index.filter(e => !pathSet.has(e));
    this.pathIndex.delete(path);
  }

  /** Adds entries and updates the Map */
  private addEntries(entries: IndexEntry[]): void {
    for (const entry of entries) {
      this.index.push(entry);
      const arr = this.pathIndex.get(entry.path);
      if (arr) arr.push(entry);
      else this.pathIndex.set(entry.path, [entry]);
    }
  }

  /** Clears both the flat array and the Map */
  private clearIndex(): void {
    this.index = [];
    this.pathIndex.clear();
  }

  /** Rebuilds the pathIndex Map from the flat array (used after deserialization) */
  private rebuildPathIndex(): void {
    this.pathIndex.clear();
    for (const entry of this.index) {
      const arr = this.pathIndex.get(entry.path);
      if (arr) arr.push(entry);
      else this.pathIndex.set(entry.path, [entry]);
    }
  }

  constructor(plugin: HormePlugin) {
    this.plugin = plugin;
    // Explicitly resolve the plugin directory relative to the vault root
    const configDir = this.plugin.app.vault.configDir;
    this.indexPath = normalizePath(`${configDir}/plugins/${this.plugin.manifest.id}/Vault Index/vault-index.json`);
    console.log(`Horme Brain: Initializing index at ${this.indexPath}`);
    this.loadIndex();

    // Wipe index if embedding model changes while plugin is running
    this.plugin.onSettingsChange(() => {
      const current = this.plugin.settings.ragEmbeddingModel;
      if (this.indexedModel && this.indexedModel !== current) {
        console.log(`Horme Brain: Model changed to ${current}. Clearing in-memory index and shard files.`);
        this.clearIndex();
        this.indexedModel = current;
        this.deleteAllShards().catch(e =>
          this.plugin.diagnosticService.report("Vault Brain", `Failed to delete stale shard files: ${e.message}`)
        );
        new Notice("Vault Brain: Embedding model changed. Index cleared — please rebuild.");
      }
    });
  }

  private readonly SHARD_SIZE = 5000;

  private getShardPath(shardIndex: number): string {
    const configDir = this.plugin.app.vault.configDir;
    return normalizePath(
      `${configDir}/plugins/${this.plugin.manifest.id}/Vault Index/vault-index-shard-${String(shardIndex).padStart(3, "0")}.json`
    );
  }

  private async loadIndex(): Promise<void> {
    try {
      // New sharded format: look for the first shard file
      if (await this.plugin.app.vault.adapter.exists(this.getShardPath(0))) {
        await this.loadShardedIndex();
        return;
      }

      // Old monolithic format: migrate and delete the old file
      if (await this.plugin.app.vault.adapter.exists(this.indexPath)) {
        console.log("Horme Brain: Migrating from monolithic to sharded index...");
        const data = await this.plugin.app.vault.adapter.read(this.indexPath);
        const parsed = JSON.parse(data);

        if (Array.isArray(parsed)) {
          // Very old format — wipe
          this.clearIndex();
          this.indexedModel = "";
        } else {
          this.indexedModel = parsed.model || "";
          this.index = (parsed.entries || []).map((e: any) => ({
            ...e,
            embedding: typeof e.embedding === "string" ? decompressEmbedding(e.embedding) : e.embedding
          }));
          this.rebuildPathIndex();
          const currentModel = this.plugin.settings.ragEmbeddingModel;
          if (this.indexedModel !== currentModel) {
            this.clearIndex();
            this.indexedModel = currentModel;
          }
        }

        // Save in new sharded format and remove the old monolithic file
        await this.saveIndex();
        await this.plugin.app.vault.adapter.remove(this.indexPath);
        console.log(`Horme Brain: Migration complete. ${this.index.length} entries across ${Math.ceil(this.index.length / this.SHARD_SIZE)} shards.`);
        return;
      }

      console.log("Horme Brain: No existing index found.");
    } catch (e) {
      this.plugin.diagnosticService.report("Vault Brain", `Critical load failure: ${e.message}`);
      this.clearIndex();
    } finally {
      this.isLoaded = true;
    }
  }

  private async loadShardedIndex(): Promise<void> {
    this.clearIndex();
    let shardIndex = 0;

    while (true) {
      const path = this.getShardPath(shardIndex);
      if (!(await this.plugin.app.vault.adapter.exists(path))) break;

      try {
        const data = await this.plugin.app.vault.adapter.read(path);
        const parsed = JSON.parse(data);

        // Validate model on the first shard only
        if (shardIndex === 0) {
          this.indexedModel = parsed.model || "";
          const currentModel = this.plugin.settings.ragEmbeddingModel;
          if (this.indexedModel !== currentModel) {
            console.log(`Horme Brain: Embedding model changed (${this.indexedModel} → ${currentModel}). Wiping all shards.`);
            this.clearIndex();
            this.indexedModel = currentModel;
            await this.deleteAllShards();
            return;
          }
        }

        const decompressed = (parsed.entries || []).map((e: any) => ({
          ...e,
          embedding: typeof e.embedding === "string"
            ? decompressEmbedding(e.embedding)
            : e.embedding
        }));
        // Use a safe concat to avoid "Maximum call stack size exceeded" errors on large vaults
        this.index = this.index.concat(decompressed);
      } catch (e) {
        this.plugin.diagnosticService.report("Vault Brain", `Failed to read index shard ${shardIndex}: ${e.message}`);
        break;
      }

      shardIndex++;
    }

    this.rebuildPathIndex();
    console.log(`Horme Brain: Loaded ${this.index.length} entries from ${shardIndex} shards (model: ${this.indexedModel}).`);
  }

  private async saveIndex(): Promise<void> {
    try {
      const adapter = this.plugin.app.vault.adapter;
      const configDir = this.plugin.app.vault.configDir;
      const folderPath = normalizePath(`${configDir}/plugins/${this.plugin.manifest.id}/Vault Index`);
      if (!(await adapter.exists(folderPath))) await adapter.mkdir(folderPath);

      const currentModel = this.plugin.settings.ragEmbeddingModel;

      // Serialize all entries, compressing any still in raw number[] form
      const serialized = this.index.map(e => ({
        path: e.path,
        chunkStart: e.chunkStart,
        chunkEnd: e.chunkEnd,
        embedding: typeof e.embedding === "string"
          ? e.embedding
          : compressEmbedding(e.embedding as number[]),
        mtime: e.mtime,
        ...(e.summaryText ? { summaryText: e.summaryText } : {}),
        ...(e.tagsText ? { tagsText: e.tagsText } : {}),
        ...(e.headingPath ? { headingPath: e.headingPath } : {})
      }));

      const totalShards = Math.max(1, Math.ceil(serialized.length / this.SHARD_SIZE));

      // Write each shard as a separate file
      for (let i = 0; i < totalShards; i++) {
        const shardEntries = serialized.slice(i * this.SHARD_SIZE, (i + 1) * this.SHARD_SIZE);
        const shardData = JSON.stringify({
          model: currentModel,
          shard: i,
          totalShards,
          entries: shardEntries
        });
        await this.plugin.app.vault.adapter.write(this.getShardPath(i), shardData);
      }

      // Delete any stale shard files left over from a previously larger index
      for (let i = totalShards; ; i++) {
        const stalePath = this.getShardPath(i);
        if (await this.plugin.app.vault.adapter.exists(stalePath)) {
          await this.plugin.app.vault.adapter.remove(stalePath);
        } else {
          break;
        }
      }

      this.indexedModel = currentModel;
    } catch (e) {
      this.plugin.diagnosticService.report("Vault Brain", `Critical save failure: ${e.message}`);
      new HormeErrorModal(
        this.plugin.app,
        "Vault Brain: Index save failed",
        "Horme could not save the vault index to disk. Indexing has been paused to prevent data loss.",
        String(e)
      ).open();
    }
  }

  private async deleteAllShards(): Promise<void> {
    for (let i = 0; ; i++) {
      const path = this.getShardPath(i);
      if (await this.plugin.app.vault.adapter.exists(path)) {
        await this.plugin.app.vault.adapter.remove(path);
      } else {
        break;
      }
    }
  }

  /**
   * Best-effort save triggered on plugin unload.
   * Fire-and-forget — Electron gives normal closes enough time to complete.
   */
  flush(): void {
    if (!this.isIndexing || this.index.length === 0) return;
    console.log("Horme Brain: Obsidian closing mid-index — flushing progress...");
    this.plugin.settings.indexStatus = "Interrupted — resume rebuild to continue";
    this.plugin.saveSettings();
    this.saveIndex()
      .then(() => console.log("Horme Brain: Emergency flush complete."))
      .catch(e => console.error("Horme Brain: Emergency flush failed.", e));
  }



  isIndexing = false;
  public isLoaded = false;

  /** Extracts all markdown headings with their character offsets */
  private extractHeadings(content: string): Array<{level: number; text: string; offset: number}> {
    const headings: Array<{level: number; text: string; offset: number}> = [];
    const regex = /^(#{1,6})\s+(.+)$/gm;
    let match;
    while ((match = regex.exec(content)) !== null) {
      headings.push({ level: match[1].length, text: match[2].trim(), offset: match.index });
    }
    return headings;
  }

  /** Returns the heading hierarchy path at a given character offset */
  private getHeadingPathAtOffset(headings: Array<{level: number; text: string; offset: number}>, offset: number): string {
    const stack: string[] = [];
    const levelStack: number[] = [];
    for (const h of headings) {
      if (h.offset > offset) break;
      while (levelStack.length > 0 && levelStack[levelStack.length - 1] >= h.level) {
        stack.pop();
        levelStack.pop();
      }
      stack.push(h.text);
      levelStack.push(h.level);
    }
    return stack.join(' > ');
  }

  private extractFrontmatterSummary(content: string, file: TFile): { fullText: string; summaryOnly: string; tagsOnly: string } | null {
    // Extract YAML frontmatter block (support both LF and CRLF)
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fmMatch) return null;

    const fm = fmMatch[1];
    let summaryOnly = "";
    let tagsOnly = "";

    const resumenMatch = fm.match(/(?:Resumen|Summary|summary|description|abstract):\s*([\s\S]*?)(?=\n\w+:|---|$)/i);
    if (resumenMatch) summaryOnly = resumenMatch[1].trim();

    const tagsMatch = fm.match(/tags:\s*([\s\S]*?)(?=\n\w+:|---|$)/i);
    if (tagsMatch) {
      const tags = tagsMatch[1]
        .split("\n")
        .map(l => l.replace(/^\s*-\s*/, "").replace(/[/_]/g, " ").trim())
        .filter(t => t.length > 0);
      if (tags.length > 0) tagsOnly = tags.join(", ");
    }

    // Build the full semantic string for embedding (with nomic prefix)
    const parts: string[] = [`${file.basename}`];
    if (summaryOnly) parts.push(summaryOnly);
    if (tagsOnly) parts.push("Temas: " + tagsOnly);

    const autorMatch = fm.match(/Autor:\s*(.+)/i);
    if (autorMatch) parts.push("Autor: " + autorMatch[1].trim());

    return {
      fullText: `${getModelPrefixes(this.plugin.settings.ragEmbeddingModel).document}${parts.join("\n")}`,
      summaryOnly,
      tagsOnly
    };
  }

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
    let consecutiveErrors = 0;
    
    this.plugin.settings.indexStatus = `Indexing (0/${total})...`;
    this.plugin.saveSettings();
    this.plugin.setIndexingStatus(`Indexing 0 / ${total}`);

    for (let i = 0; i < total; i++) {
      const file = files[i];
      if (i % 5 === 0) {
        this.plugin.settings.indexStatus = `Indexing (${i + 1}/${total}): ${file.name.slice(0, 20)}...`;
        this.plugin.setIndexingStatus(`Indexing ${i + 1} / ${total}`);
      }
      
      const existing = this.getEntriesForPath(file.path);
      if (existing.length > 0 && existing[0].mtime >= file.stat.mtime) {
        continue;
      }

      this.removeEntriesForPath(file.path);

      try {
        const content = await this.plugin.app.vault.read(file);
        if (!content.trim()) continue;

        const chunksWithOffsets = this.plugin.embeddingService.chunkTextWithOffsets(content);
        const validChunks = chunksWithOffsets.filter(c => c.text.trim().length > 0);
        
        if (validChunks.length > 0) {
          // Extract heading structure for heading-aware chunking
          const headings = this.extractHeadings(content);

          // Build embedding texts with search_document prefix and heading context
          const embeddingTexts = validChunks.map(c => {
            const hp = this.getHeadingPathAtOffset(headings, c.start);
            const docPrefix = getModelPrefixes(this.plugin.settings.ragEmbeddingModel).document;
            return `${docPrefix}${file.basename}${hp ? ' > ' + hp : ''}\n\n${c.text}`;
          });

          // Add a dedicated frontmatter summary embedding (offset 0,0 = signals summary entry)
          const fmData = this.extractFrontmatterSummary(content, file);
          const hasFmSummary = fmData !== null;
          if (hasFmSummary) embeddingTexts.unshift(fmData.fullText);

          const embeddings = await this.plugin.embeddingService.getEmbeddings(embeddingTexts);

          const newEntries: IndexEntry[] = [];
          let embOffset = 0;
          if (hasFmSummary) {
            if (embeddings[0] && embeddings[0].length > 0) {
              newEntries.push({
                path: file.path,
                chunkStart: 0,
                chunkEnd: 0,
                embedding: embeddings[0],
                mtime: file.stat.mtime,
                summaryText: fmData.summaryOnly,
                tagsText: fmData.tagsOnly
              });
            }
            embOffset = 1;
          }

          // Store chunk embeddings with heading path
          for (let j = 0; j < validChunks.length; j++) {
            const emb = embeddings[j + embOffset];
            if (emb && emb.length > 0) {
              const hp = this.getHeadingPathAtOffset(headings, validChunks[j].start);
              newEntries.push({
                path: file.path,
                chunkStart: validChunks[j].start,
                chunkEnd: validChunks[j].end,
                embedding: emb,
                mtime: file.stat.mtime,
                ...(hp ? { headingPath: hp } : {})
              });
            }
          }
          this.addEntries(newEntries);
        }
        updatedCount++;
        consecutiveErrors = 0; // reset on success

        // Auto-save checkpoint every 50 files to prevent progress loss
        if (updatedCount % 50 === 0) {
          await this.saveIndex();
        }
      } catch (e) {
        this.plugin.diagnosticService.report("Vault Brain", `Note skipped: ${file.path} (${e.message})`, "warning");
        consecutiveErrors++;
        // (e.g. one bad file) should not stop the entire rebuild.
        if (consecutiveErrors > 15) {
          new HormeErrorModal(
            this.plugin.app,
            "Vault Brain: Indexing paused",
            `Indexing stopped after ${consecutiveErrors} consecutive failures. This usually means Ollama is unreachable or the embedding model is not loaded. Check that Ollama is running and that the model "${this.plugin.settings.ragEmbeddingModel}" is available.`,
            `Last error: check the developer console (Ctrl+Shift+I) for details.`
          ).open();
          this.plugin.settings.indexStatus = "Failed (too many consecutive errors)";
          await this.plugin.saveSettings();
          return;
        }
      }
    }

    await this.saveIndex();
    this.plugin.settings.indexStatus = "Ready";
    await this.plugin.saveSettings();
    this.plugin.setIndexingStatus(null);
    
    if (consecutiveErrors > 0) {
      new Notice(`Vault Brain: Indexed ${updatedCount} files. (Some failed — check console)`);
    } else {
      new Notice(`Vault Brain: Successfully indexed ${updatedCount} files.`);
    }
  } catch (e) {
    this.plugin.diagnosticService.report("Vault Brain", `Fatal indexing error: ${e.message}`);
    new HormeErrorModal(
      this.plugin.app,
      "Vault Brain: Fatal indexing error",
      "Indexing stopped due to an unexpected error. Your partial progress has been saved and the next rebuild will resume from where it left off.",
      String(e)
    ).open();
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

    // Wait for the index to finish loading from disk before processing any changes.
    // If we process and save a partial index during startup, we risk overwriting
    // the full shard files with only the freshly modified notes.
    if (!this.isLoaded) {
      const deadline = Date.now() + 5000;
      while (!this.isLoaded && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 100));
      }
      if (!this.isLoaded) {
        console.warn("Horme Brain: Index not yet loaded after timeout, proceeding with queue anyway.");
      }
    }

    try {
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
          // Yield to the UI thread between files — prevents typing lag.
          // indexFile() no longer calls saveIndex() internally, so the only
          // blocking JSON.stringify happens once below when the queue drains.
          await new Promise(r => setTimeout(r, 50));
        }
      }

      // Save once when the queue is fully drained instead of after every file.
      // This eliminates repeated synchronous JSON.stringify calls that block typing.
      if (this.index.length > 0) {
        await this.saveIndex();
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  /**
   * Indexes a single file (Internal use by queue or rebuild).
   */
  private async indexFile(file: TFile) {
    // Remove old entries
    this.removeEntriesForPath(file.path);

    try {
      const content = await this.plugin.app.vault.read(file);
      if (!content.trim()) return;

      const chunksWithOffsets = this.plugin.embeddingService.chunkTextWithOffsets(content);
      const validChunks = chunksWithOffsets.filter(c => c.text.trim().length > 0);
      
      if (validChunks.length > 0) {
        const headings = this.extractHeadings(content);

        const embeddingTexts = validChunks.map(c => {
          const hp = this.getHeadingPathAtOffset(headings, c.start);
          const docPrefix = getModelPrefixes(this.plugin.settings.ragEmbeddingModel).document;
          return `${docPrefix}${file.basename}${hp ? ' > ' + hp : ''}\n\n${c.text}`;
        });

        const fmData = this.extractFrontmatterSummary(content, file);
        const hasFmSummary = fmData !== null;
        if (hasFmSummary) embeddingTexts.unshift(fmData.fullText);

        const embeddings = await this.plugin.embeddingService.getEmbeddings(embeddingTexts);

        const newEntries: IndexEntry[] = [];
        let embOffset = 0;
        if (hasFmSummary) {
          if (embeddings[0] && embeddings[0].length > 0) {
            newEntries.push({
              path: file.path,
              chunkStart: 0,
              chunkEnd: 0,
              embedding: embeddings[0],
              mtime: file.stat.mtime,
              summaryText: fmData.summaryOnly,
              tagsText: fmData.tagsOnly
            });
          }
          embOffset = 1;
        }

        for (let j = 0; j < validChunks.length; j++) {
          const emb = embeddings[j + embOffset];
          if (emb && emb.length > 0) {
            const hp = this.getHeadingPathAtOffset(headings, validChunks[j].start);
            newEntries.push({
              path: file.path,
              chunkStart: validChunks[j].start,
              chunkEnd: validChunks[j].end,
              embedding: emb,
              mtime: file.stat.mtime,
              ...(hp ? { headingPath: hp } : {})
            });
          }
        }
        this.addEntries(newEntries);
        // NOTE: saveIndex() is intentionally NOT called here.
        // It is called once by processQueue() when the queue drains,
        // to avoid blocking the UI thread with repeated JSON.stringify calls.
      }
    } catch (e) {
      this.plugin.diagnosticService.report("Vault Brain", `Auto-index failed for ${file.path}: ${e.message}`, "warning");
    }
  }

  /**
   * Multi-query hybrid search using vector similarity + keyword boosting.
   * Uses nomic-embed-text search_query prefix and dual-embedding fusion.
   */
  async search(query: string, topN = 20): Promise<string[]> {
    console.log(`Horme Brain: Search called. Index size: ${this.index.length}`);
    const canAccess = this.plugin.isLocalProviderActive() || this.plugin.settings.allowCloudRAG;
    if (!this.plugin.settings.vaultBrainEnabled || !canAccess) {
      if (!canAccess) this.plugin.diagnosticService.report("Horme Privacy Guard", "Vault search blocked (Cloud Provider Active & allowCloudRAG is OFF).", "warning");
      return [];
    }

    // Wait for the index to finish loading from disk before searching.
    // The constructor calls loadIndex() fire-and-forget, so an early search
    // (e.g. immediately after plugin load) might otherwise see an empty index.
    if (!this.isLoaded) {
      const deadline = Date.now() + 5000;
      while (!this.isLoaded && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 100));
      }
      if (!this.isLoaded) {
        this.plugin.diagnosticService.report("Horme Brain", "Index not yet loaded, skipping search.", "warning");
        return [];
      }
    }

    try {
      // 1. Refine query: remove conversational junk
      const refinedQuery = query.toLowerCase()
        .replace(/^(?:ayúdame a encontrar|podrías ayudarme a encontrar|busca|encuentra|dime sobre|háblame de|tienes algo sobre|algún artículo sobre|alguna nota sobre)\s+/i, "")
        .trim();
      
      // 1.5 Extract quoted terms for exact-match priority
      const quotedMatches = query.match(/"([^"]+)"/g) || [];
      const quotedTerms = quotedMatches.map(m => m.replace(/"/g, "").toLowerCase());

      // Strip punctuation for cleaner search terms, but preserve spaces
      const cleanedQuery = refinedQuery.replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, " ");
      const searchTerms = cleanedQuery.split(/\s+/).filter(t => t.length > 2);
      
      // 2. Truncate very long queries (e.g. user pasting whole articles) to a
      //    focused portion for embedding — models work best with focused queries.
      //    We keep the first 500 chars, which captures the topic without dilution.
      const MAX_EMBED_CHARS = 500;
      const embeddingQuery = refinedQuery.length > MAX_EMBED_CHARS
        ? refinedQuery.slice(0, MAX_EMBED_CHARS)
        : refinedQuery;

      // 3. Multi-query: full (truncated) query + keyword-distilled variant.
      // If Ollama rejects or times out (any error, not just "context length"),
      // fall back to keyword-only scoring instead of returning zero results.
      const { query: qPrefix } = getModelPrefixes(this.plugin.settings.ragEmbeddingModel);
      let primaryEmbedding: number[] = [];
      let secondaryEmbedding: number[] | null = null;

      try {
        primaryEmbedding = await this.plugin.embeddingService.getEmbedding(`${qPrefix}${embeddingQuery}`);
        const keyTerms = searchTerms.filter(t => t.length > 3).join(' ');
        if (keyTerms && keyTerms !== embeddingQuery) {
          secondaryEmbedding = await this.plugin.embeddingService.getEmbedding(`${qPrefix}${keyTerms}`);
        }
      } catch (embErr) {
        // Embedding failed (Ollama down, model not loaded, long-text timeout, etc.)
        // Log and continue with vector scores zeroed out — keyword bonus alone will
        // Still surface obvious matches like the exact-title case.
        this.plugin.diagnosticService.report("Search", "Embedding failed. Falling back to keyword search.", "warning");
      }

      const MIN_SIMILARITY = 0.10; // Lowered: keyword-only searches can still score ~0.25+

      // 4. Score all entries: max(primary, secondary) + keyword bonus
      const scored = this.index
        .map(entry => {
          const emb = typeof entry.embedding === "string" 
            ? decompressEmbedding(entry.embedding) 
            : entry.embedding;

          const primaryScore = cosineSimilarity(primaryEmbedding, emb);
          const secondaryScore = secondaryEmbedding ? cosineSimilarity(secondaryEmbedding, emb) : 0;
          const vectorScore = Math.max(primaryScore, secondaryScore);

          // Keyword boosting: Exact quotes (Major) + Regular terms (Minor)
          let keywordBonus = 0;
          const lowerPath = entry.path.toLowerCase();
          const lowerSummary = (entry.summaryText || "").toLowerCase();
          const lowerTags = (entry.tagsText || "").toLowerCase();
          const lowerHeading = (entry.headingPath || "").toLowerCase();
          
          // 1. Quoted terms get a massive priority boost
          for (const term of quotedTerms) {
            if (lowerPath.includes(term) || lowerSummary.includes(term) || lowerTags.includes(term) || lowerHeading.includes(term)) {
              keywordBonus += 2.0;
            }
          }

          // 2. Regular keyword boosting, skipping stop-words
          for (const term of searchTerms) {
            if (STOP_WORDS.has(term)) continue;
            if (lowerPath.includes(term)) keywordBonus += 0.25;
            if (lowerSummary.includes(term)) keywordBonus += 0.20;
            if (lowerTags.includes(term)) keywordBonus += 0.15;
            if (lowerHeading.includes(term)) keywordBonus += 0.20;
          }

          // Cap the bonus so it doesn't exponentially drown out semantic vector scores
          keywordBonus = Math.min(keywordBonus, 5.0);

          return { entry, score: vectorScore + keywordBonus };
        })
        .filter(s => s.score >= MIN_SIMILARITY)
        .sort((a, b) => b.score - a.score)
        .slice(0, topN);

      // 5. Fetch content for top results
      const results: string[] = [];
      console.log(`%cHorme Brain: Top ${scored.length} search results:`, "color: #34d399; font-weight: bold;");
      scored.forEach((s, idx) => {
        console.log(`  %c${idx + 1}. [Score: ${s.score.toFixed(3)}]%c ${s.entry.path}${s.entry.headingPath ? " > " + s.entry.headingPath : ""}`, "color: #34d399; font-weight: bold;", "color: inherit;");
      });

      for (const { entry } of scored) {
        try {
          const abstractFile = this.plugin.app.vault.getAbstractFileByPath(entry.path);
          if (!(abstractFile instanceof TFile)) continue;
          const content = await this.plugin.app.vault.read(abstractFile);

          let chunk: string;
          if (entry.chunkStart === 0 && entry.chunkEnd === 0) {
            chunk = content.slice(0, 600).trim();
          } else {
            chunk = content.slice(entry.chunkStart, entry.chunkEnd).trim();
          }

          const heading = entry.headingPath ? ` (${entry.headingPath})` : "";
          if (chunk) results.push(`[From ${entry.path}${heading}]:\n${chunk}`);
        } catch {
          // File deleted or unreadable — skip silently
        }
      }

      return results;
    } catch (e) {
      console.error("Horme: Search failed", e);
      this.plugin.diagnosticService.report("Search", `Search failed: ${e.message}`);
      return [];
    }
  }
}
