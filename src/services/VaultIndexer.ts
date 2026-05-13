import { TFile, Notice, normalizePath } from "obsidian";
import HormePlugin from "../../main";
import { HormeErrorModal } from "../modals/HormeErrorModal";
import {
  compressEmbedding,
  cosineSimilarityFloatInt8,
  cosineSimilarityInt8,
  decompressEmbeddingToInt8,
  getModelPrefixes,
  quantizeEmbeddingToInt8
} from "../utils/VectorUtils";
import { OllamaProvider } from "../providers/OllamaProvider";
import { LmStudioProvider } from "../providers/LmStudioProvider";
import { asArray, asNumberArray, errorToMessage, getNumberProp, getRecordProp, getStringProp } from "../utils/TypeGuards";

interface IndexEntry {
  path: string;
  chunkStart: number;
  chunkEnd: number;
  embedding: Int8Array | string;
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
  // Cache of Spanish tag string → bilingual tag string.
  // Built during indexing to avoid redundant LLM calls for notes sharing the same tags.
  // Cleared when the plugin unloads (in-memory only — intentionally not persisted).
  private tagTranslationCache: Map<string, string> = new Map();
  private hasReportedEmptyTagTranslationModel = false;

  /** O(1) lookup of entries by path */
  private getEntriesForPath(path: string): IndexEntry[] {
    return this.pathIndex.get(path) || [];
  }

  /** Removes all entries for a given path from both the flat array and the Map */
  public removeEntriesForPath(path: string): void {
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
    void this.loadIndex();

    // Wipe index if embedding model changes while plugin is running
    this.plugin.onSettingsChange(() => {
      const current = this.plugin.settings.ragEmbeddingModel;
      if (this.indexedModel && this.indexedModel !== current) {
        console.log(`Horme Brain: Model changed to ${current}. Clearing in-memory index and shard files.`);
        this.clearIndex();
        this.indexedModel = current;
        this.deleteAllShards().catch((e: unknown) => {
          this.plugin.diagnosticService.report("Vault Brain", `Failed to delete stale shard files: ${errorToMessage(e)}`);
        });
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
        const parsed: unknown = JSON.parse(data);

        if (Array.isArray(parsed)) {
          // Very old format — wipe
          this.clearIndex();
          this.indexedModel = "";
        } else {
          this.indexedModel = getStringProp(parsed, "model") ?? "";
          this.index = this.parseEntries(getRecordProp(parsed, "entries"));
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
    } catch (e: unknown) {
      this.plugin.diagnosticService.report("Vault Brain", `Critical load failure: ${errorToMessage(e)}`);
      this.clearIndex();
    } finally {
      this.isLoaded = true;
    }
  }

  private parseEntries(entriesUnknown: unknown): IndexEntry[] {
    const entries = asArray(entriesUnknown) ?? [];
    const out: IndexEntry[] = [];
    for (const e of entries) {
      const path = getStringProp(e, "path");
      const chunkStart = getNumberProp(e, "chunkStart");
      const chunkEnd = getNumberProp(e, "chunkEnd");
      const mtime = getNumberProp(e, "mtime");
      if (!path || chunkStart === undefined || chunkEnd === undefined || mtime === undefined) continue;

      const embeddingUnknown = getRecordProp(e, "embedding");
      let embedding: Int8Array | string = new Int8Array();
      if (typeof embeddingUnknown === "string") embedding = decompressEmbeddingToInt8(embeddingUnknown);
      else {
        const embArr = asNumberArray(embeddingUnknown);
        if (embArr) embedding = quantizeEmbeddingToInt8(embArr);
      }

      const summaryText = getStringProp(e, "summaryText");
      const tagsText = getStringProp(e, "tagsText");
      const headingPath = getStringProp(e, "headingPath");

      out.push({
        path,
        chunkStart,
        chunkEnd,
        embedding,
        mtime,
        ...(summaryText ? { summaryText } : {}),
        ...(tagsText ? { tagsText } : {}),
        ...(headingPath ? { headingPath } : {}),
      });
    }
    return out;
  }

  private async loadShardedIndex(): Promise<void> {
    this.clearIndex();
    let shardIndex = 0;

    while (true) {
      const path = this.getShardPath(shardIndex);
      if (!(await this.plugin.app.vault.adapter.exists(path))) break;

      try {
        const data = await this.plugin.app.vault.adapter.read(path);
        const parsed: unknown = JSON.parse(data);

        // Validate model on the first shard only
        if (shardIndex === 0) {
          this.indexedModel = getStringProp(parsed, "model") ?? "";
          const currentModel = this.plugin.settings.ragEmbeddingModel;
          if (this.indexedModel !== currentModel) {
            console.log(`Horme Brain: Embedding model changed (${this.indexedModel} → ${currentModel}). Wiping all shards.`);
            this.clearIndex();
            this.indexedModel = currentModel;
            await this.deleteAllShards();
            return;
          }
        }

        const decompressed = this.parseEntries(getRecordProp(parsed, "entries"));
        // Use a safe concat to avoid "Maximum call stack size exceeded" errors on large vaults
        this.index = this.index.concat(decompressed);
      } catch (e: unknown) {
        this.plugin.diagnosticService.report("Vault Brain", `Failed to read index shard ${shardIndex}: ${errorToMessage(e)}`);
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
	          : compressEmbedding(e.embedding),
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
    } catch (e: unknown) {
      this.plugin.diagnosticService.report("Vault Brain", `Critical save failure: ${errorToMessage(e)}`);
      new HormeErrorModal(
        this.plugin.app,
        "Vault Brain: Index save failed",
        "Horme could not save the vault index to disk. Indexing has been paused to prevent data loss.",
        String(e)
      ).open();
    }
  }

  private getVaultIndexFolderPath(): string {
    const configDir = this.plugin.app.vault.configDir;
    return normalizePath(`${configDir}/plugins/${this.plugin.manifest.id}/Vault Index`);
  }

  async hasBuiltIndex(): Promise<boolean> {
    if (this.index.length > 0) return true;
    const adapter = this.plugin.app.vault.adapter;
    const currentModel = this.plugin.settings.ragEmbeddingModel;

    try {
      const shard0Path = this.getShardPath(0);
      if (await adapter.exists(shard0Path)) {
        try {
          const raw = await adapter.read(shard0Path);
          const parsed: unknown = JSON.parse(raw);
          const model = getStringProp(parsed, "model");
          if (model && model !== currentModel) return false;
          return Array.isArray(getRecordProp(parsed, "entries"));
        } catch {
          return false;
        }
      }

      if (await adapter.exists(this.indexPath)) {
        try {
          const raw = await adapter.read(this.indexPath);
          const parsed: unknown = JSON.parse(raw);
          if (Array.isArray(parsed)) return parsed.length > 0;
          const model = getStringProp(parsed, "model");
          if (model && model !== currentModel) return false;
          return Array.isArray(getRecordProp(parsed, "entries"));
        } catch {
          return false;
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  private async deleteAllShards(): Promise<number> {
    const adapter = this.plugin.app.vault.adapter;
    const folderPath = this.getVaultIndexFolderPath();
    if (!(await adapter.exists(folderPath))) return 0;

    const listed = await adapter.list(folderPath);
    const shardFiles = listed.files.filter((path) => /vault-index-shard-\d+\.json$/i.test(path));

    for (const path of shardFiles) {
      await adapter.remove(path);
    }
    return shardFiles.length;
  }

  async deleteIndex(): Promise<"deleted" | "missing" | "blocked"> {
    if (this.isIndexing || this.isProcessingQueue) {
      new Notice("Vault Brain: Please wait for indexing to finish before deleting the index.");
      return "blocked";
    }

    try {
      const adapter = this.plugin.app.vault.adapter;
      const hadInMemory = this.index.length > 0;
      const hadLegacy = await adapter.exists(this.indexPath);
      const removedShardCount = await this.deleteAllShards();

      if (hadLegacy) {
        await adapter.remove(this.indexPath);
      }

      this.indexingQueue = [];
      this.clearIndex();
      this.tagTranslationCache.clear();
      this.indexedModel = "";
      this.plugin.settings.indexStatus = "Not built";
      await this.plugin.saveSettings();
      this.plugin.setIndexingStatus(null);

      if (hadInMemory || hadLegacy || removedShardCount > 0) {
        this.plugin.diagnosticService.report("Vault Brain", "Vault index deleted by user.", "info");
        return "deleted";
      }
      this.plugin.diagnosticService.report("Vault Brain", "Delete requested, but no vault index was found.", "info");
      return "missing";
    } catch (e: unknown) {
      this.plugin.diagnosticService.report("Vault Brain", `Failed to delete index: ${errorToMessage(e)}`);
      throw e instanceof Error ? e : new Error(errorToMessage(e));
    }
  }

  /**
   * Best-effort save triggered on plugin unload.
   * Fire-and-forget — Electron gives normal closes enough time to complete.
   */
  flush(): void {
    if (this.index.length === 0) return;
    if (!this.isIndexing && !this.isProcessingQueue) return;
    console.log("Horme Brain: Obsidian closing mid-index — flushing progress...");
    this.plugin.settings.indexStatus = "Interrupted — resume rebuild to continue";
    void this.plugin.saveSettings().catch(e => this.plugin.handleError(e, "Vault Brain"));
    this.saveIndex()
      .then(() => console.log("Horme Brain: Emergency flush complete."))
      .catch((e: unknown) => {
        console.error("Horme Brain: Emergency flush failed.", e);
        this.plugin.diagnosticService.report("Vault Brain", `Emergency flush failed: ${errorToMessage(e)}`);
      });
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

  private normalizeTagForIndex(tag: string): string {
    return tag.replace(/^#+/, "").replace(/[/_]/g, " ").trim();
  }

  private extractTagValues(raw: unknown): string[] {
    if (raw == null) return [];

    if (Array.isArray(raw)) {
      const out: string[] = [];
      for (const item of raw) out.push(...this.extractTagValues(item));
      return out;
    }

    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (!trimmed) return [];

      const bracketArray = trimmed.match(/^\[(.*)\]$/);
      const normalized = bracketArray ? bracketArray[1] : trimmed;
      return normalized
        .split(",")
        .map((v) => v.trim().replace(/^["']|["']$/g, ""))
        .filter((v) => v.length > 0);
    }

    return [];
  }

  /**
   * Collects tags for shadow-tagging from metadata cache (inline + YAML),
   * with frontmatter/raw-text fallbacks when cache is incomplete.
   */
  private collectShadowTags(content: string, file: TFile, frontmatterBlock?: string): string {
    const collected = new Set<string>();
    const add = (value: string) => {
      const normalized = this.normalizeTagForIndex(value);
      if (normalized.length > 0) collected.add(normalized);
    };

    const cache = this.plugin.app.metadataCache.getFileCache(file);
    if (cache?.tags) {
      for (const t of cache.tags) add(t.tag);
    }

    const frontmatter = cache?.frontmatter as Record<string, unknown> | undefined;
    if (frontmatter) {
      for (const tag of this.extractTagValues(frontmatter.tags)) add(tag);
      for (const tag of this.extractTagValues(frontmatter.tag)) add(tag);
    }

    if (frontmatterBlock) {
      const tagsMatch = frontmatterBlock.match(/tags:\s*([\s\S]*?)(?=\n\w+:|---|$)/i);
      if (tagsMatch) {
        tagsMatch[1]
          .split("\n")
          .map((line) => line.replace(/^\s*-\s*/, "").trim())
          .forEach((tag) => add(tag));
      }
    }

    const inlineTagRegex = /(^|\s)#([^\s#]+)/gm;
    let match: RegExpExecArray | null;
    while ((match = inlineTagRegex.exec(content)) !== null) {
      add(match[2]);
    }

    return Array.from(collected)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
      .join(", ");
  }

  /**
   * Translates a Spanish tag string to English and returns a bilingual
   * combined string. Results are cached so notes sharing the same tag
   * set only pay the LLM cost once per rebuild session.
   *
   * Falls back silently to the original Spanish string on any error —
   * the index still works, just without the bilingual enrichment.
   */
  private async translateTagsBilingually(spanishTags: string, reportConfigurationWarning = true): Promise<string> {
    if (!this.plugin.settings.tagShadowingEnabled || !spanishTags.trim()) return spanishTags;

    // Cache hit — no LLM call needed
    const cached = this.tagTranslationCache.get(spanishTags);
    if (cached !== undefined) return cached;

    try {
      const settings = this.plugin.settings;
      // IMPORTANT: Tag translation must be stable and independent from chat usage.
      // Only the explicitly configured Tag Translation Provider + Tag Translation Model are used.
      const model = settings.tagTranslationModel.trim();
      if (!model) {
        this.tagTranslationCache.set(spanishTags, spanishTags);
        if (reportConfigurationWarning && !this.hasReportedEmptyTagTranslationModel) {
          this.plugin.diagnosticService.report(
            "Vault Brain",
            "Tag translation skipped: Tag Translation Model is empty.",
            "warning"
          );
          this.hasReportedEmptyTagTranslationModel = true;
        }
        return spanishTags;
      }

      const provider =
        settings.tagTranslationProvider === "lmstudio"
          ? new LmStudioProvider(settings.lmStudioUrl, settings.temperature)
          : new OllamaProvider(settings.ollamaBaseUrl, settings.temperature);

      const result = await provider.generate(
        `Translate these tags to ${settings.tagShadowingLanguage}. Return ONLY a comma-separated list ` +
        `of equivalents with no explanation, no numbering, no quotes.\n` +
        `Tags: ${spanishTags}`,
        "", // no system prompt needed
        model
      );

      const translatedTags = result.trim().replace(/\.$/, "");
      if (!translatedTags) throw new Error("Empty translation response.");
      // Combine: Spanish original + translation
      const bilingual = `${spanishTags}, ${translatedTags}`;
      this.tagTranslationCache.set(spanishTags, bilingual);
      return bilingual;
    } catch (e: unknown) {
      // Factual Fallback: report the specific error to the dashboard but continue indexing
      this.plugin.diagnosticService.report(
        "Vault Brain", 
        `Tag translation failed (Model: ${this.plugin.settings.tagTranslationModel || "(empty)"}). ` +
        `Falling back to original tags. Error: ${errorToMessage(e)}`,
        "warning"
      );
      this.tagTranslationCache.set(spanishTags, spanishTags);
      return spanishTags;
    }
  }

  private async extractFrontmatterSummary(
    content: string,
    file: TFile,
    reportTagTranslationWarning = true
  ): Promise<{ fullText: string; summaryOnly: string; tagsOnly: string } | null> {
    // Extract YAML frontmatter block (support both LF and CRLF)
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const fm = fmMatch?.[1];
    let summaryOnly = "";
    let tagsOnly = this.collectShadowTags(content, file, fm);

    if (fm) {
      const resumenMatch = fm.match(/(?:Resumen|Summary|summary|description|abstract):\s*([\s\S]*?)(?=\n\w+:|---|$)/i);
      if (resumenMatch) summaryOnly = resumenMatch[1].trim();
    }

    // Shadow Tagging: translate Spanish tags to English and store both.
    // This allows English queries to find Spanish-tagged notes via both
    // the keyword bonus and the embedding vector.
    if (tagsOnly) {
      tagsOnly = await this.translateTagsBilingually(tagsOnly, reportTagTranslationWarning);
    }

    if (!summaryOnly && !tagsOnly) return null;

    // Build the full semantic string for embedding (with nomic prefix)
    const parts: string[] = [`${file.basename}`];
    if (summaryOnly) parts.push(summaryOnly);
    if (tagsOnly) parts.push("Temas: " + tagsOnly);

    const autorMatch = fm?.match(/Autor:\s*(.+)/i);
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
    
    // Clear the translation cache at the start of each full rebuild.
    // This ensures stale translations don't persist if the user changes
    // the active model or settings between rebuilds.
    this.tagTranslationCache.clear();
    this.hasReportedEmptyTagTranslationModel = false;

    try {
      // Decoupled Privacy Guard: Indexing is allowed if the embedding model is local (Ollama).
      // Summaries are extracted via regex (local).
      // Tag translation will be handled locally or reported as a warning if it fails.
      if (!this.plugin.settings.ragEmbeddingModel) {
        new Notice("Vault Brain: No embedding model selected.");
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
	    await this.plugin.saveSettings();
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

          const fmData = await this.extractFrontmatterSummary(content, file, true);
          const bilingualTags = fmData?.tagsOnly || "";

          // Build embedding texts with search_document prefix and heading context
          const embeddingTexts = validChunks.map(c => {
            const hp = this.getHeadingPathAtOffset(headings, c.start);
            const docPrefix = getModelPrefixes(this.plugin.settings.ragEmbeddingModel).document;
            // Prepend bilingual tags to every chunk so the vector captures both languages.
            // Tags are brief (30–80 chars) and won't dilute the body content meaningfully.
            const tagLine = bilingualTags ? `Tags: ${bilingualTags}\n` : "";
            return `${docPrefix}${file.basename}${hp ? ' > ' + hp : ''}\n${tagLine}\n${c.text}`;
          });

          // Add a dedicated frontmatter summary embedding (offset 0,0 = signals summary entry)
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
	                embedding: quantizeEmbeddingToInt8(embeddings[0]),
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
	                embedding: quantizeEmbeddingToInt8(emb),
	                mtime: file.stat.mtime,
	                ...(hp ? { headingPath: hp } : {}),
	                ...(bilingualTags ? { tagsText: bilingualTags } : {})
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
	      } catch (e: unknown) {
	        this.plugin.diagnosticService.report("Vault Brain", `Note skipped: ${file.path} (${errorToMessage(e)})`, "warning");
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
	  } catch (e: unknown) {
	    this.plugin.diagnosticService.report("Vault Brain", `Fatal indexing error: ${errorToMessage(e)}`);
	    new HormeErrorModal(
	      this.plugin.app,
	      "Vault Brain: Fatal indexing error",
	      "Indexing stopped due to an unexpected error. Your partial progress has been saved and the next rebuild will resume from where it left off.",
	      errorToMessage(e)
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
    const canIndex = this.plugin.isLocalProviderActive() || this.plugin.settings.allowCloudRAG;
    if (!canIndex || !this.plugin.settings.vaultBrainEnabled) {
      return;
    }
    // Incremental indexing is only allowed after at least one successful full build.
    if (!(await this.hasBuiltIndex())) {
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
        await new Promise<void>(r => window.setTimeout(r, 100));
      }
      if (!this.isLoaded) {
        console.warn("Horme Brain: Index not yet loaded after timeout, proceeding with queue anyway.");
        this.plugin.diagnosticService.report("Vault Brain", "Index not yet loaded after 5s timeout — proceeding with queue anyway.", "warning");
      }
    }

    try {
      while (this.indexingQueue.length > 0) {
        // Re-check on every iteration — provider may have changed since enqueue
        const canStillIndex = this.plugin.isLocalProviderActive() || this.plugin.settings.allowCloudRAG;
        if (!canStillIndex || !this.plugin.settings.vaultBrainEnabled) {
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
          await new Promise<void>(r => window.setTimeout(r, 50));
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

        const fmData = await this.extractFrontmatterSummary(content, file, false);
        const bilingualTags = fmData?.tagsOnly || "";

        const embeddingTexts = validChunks.map(c => {
          const hp = this.getHeadingPathAtOffset(headings, c.start);
          const docPrefix = getModelPrefixes(this.plugin.settings.ragEmbeddingModel).document;
          // Prepend bilingual tags to every chunk so the vector captures both languages.
          // Tags are brief (30–80 chars) and won't dilute the body content meaningfully.
          const tagLine = bilingualTags ? `Tags: ${bilingualTags}\n` : "";
          return `${docPrefix}${file.basename}${hp ? ' > ' + hp : ''}\n${tagLine}\n${c.text}`;
        });

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
	              embedding: quantizeEmbeddingToInt8(embeddings[0]),
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
	              embedding: quantizeEmbeddingToInt8(emb),
	              mtime: file.stat.mtime,
	              ...(hp ? { headingPath: hp } : {}),
	              ...(bilingualTags ? { tagsText: bilingualTags } : {})
	            });
	          }
	        }
        this.addEntries(newEntries);
        // NOTE: saveIndex() is intentionally NOT called here.
        // It is called once by processQueue() when the queue drains,
        // to avoid blocking the UI thread with repeated JSON.stringify calls.
      }
    } catch (e: unknown) {
      this.plugin.diagnosticService.report("Vault Brain", `Auto-index failed for ${file.path}: ${errorToMessage(e)}`, "warning");
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
        await new Promise<void>(r => window.setTimeout(r, 100));
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
		      } catch {
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
	            ? decompressEmbeddingToInt8(entry.embedding)
	            : entry.embedding;

	          const primaryScore =
	            primaryEmbedding.length > 0 ? cosineSimilarityFloatInt8(primaryEmbedding, emb) : 0;
	          const secondaryScore = secondaryEmbedding ? cosineSimilarityFloatInt8(secondaryEmbedding, emb) : 0;
	          const vectorScore = Math.max(primaryScore, secondaryScore);

	          // Keyword boosting: Exact quotes (Major) + Regular terms (Minor)
	          let keywordBonus = 0;
	          const lowerPath = entry.path.toLowerCase();
	          const lowerSummary = (entry.summaryText || "").toLowerCase();
	          const lowerTags = (entry.tagsText || "").toLowerCase();
	          const lowerHeading = (entry.headingPath || "").toLowerCase();

	          // 1. Quoted terms get a massive priority boost
	          for (const term of quotedTerms) {
	            if (
	              lowerPath.includes(term) ||
	              lowerSummary.includes(term) ||
	              lowerTags.includes(term) ||
	              lowerHeading.includes(term)
	            ) {
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
	        .sort((a, b) => b.score - a.score);

	      // 4.5 File-level dedup: prevent a single long note from flooding the top-N.
	      // Pass 1: take max 1 chunk per file for variety.
	      // Pass 2: if we still have capacity, allow up to 3 chunks per file.
	      const selected: Array<{ entry: IndexEntry; score: number }> = [];
	      const perFileCounts = new Map<string, number>();

	      const takeUpTo = (maxChunksPerFile: number) => {
	        for (const item of scored) {
	          if (selected.length >= topN) return;
	          const current = perFileCounts.get(item.entry.path) || 0;
	          if (current >= maxChunksPerFile) continue;
	          perFileCounts.set(item.entry.path, current + 1);
	          selected.push(item);
	        }
	      };

	      takeUpTo(1);
	      if (selected.length < topN) takeUpTo(3);

	      // 5. Fetch content for top results
	      const results: string[] = [];
	      console.log(
	        `%cHorme Brain: Top ${selected.length} search results:`,
	        "color: #34d399; font-weight: bold;"
	      );
	      selected.forEach((s, idx) => {
	        console.log(
	          `  %c${idx + 1}. [Score: ${s.score.toFixed(3)}]%c ${s.entry.path}${
	            s.entry.headingPath ? " > " + s.entry.headingPath : ""
	          }`,
	          "color: #34d399; font-weight: bold;",
	          "color: inherit;"
	        );
	      });

	      for (const { entry } of selected) {
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
		    } catch (e: unknown) {
		      console.error("Horme: Search failed", e);
		      this.plugin.diagnosticService.report("Search", `Search failed: ${errorToMessage(e)}`);
		      return [];
		    }
	  }
  /**
   * Retrieves semantically related notes for the active file.
   * Useful for the "Connections" side panel.
   */
  async getConnections(activeFilePath: string): Promise<{path: string, score: number}[] | null | undefined> {
    if (!this.plugin.settings.vaultBrainEnabled || !this.isLoaded) return null;

    const sourceEntries = this.getEntriesForPath(activeFilePath);
    if (!sourceEntries || sourceEntries.length === 0) return undefined;

    // Parse excluded folders
    const excludedPrefixes = this.plugin.settings.connectionsExcludedFolders
      .split(",")
      .map(s => s.trim())
      .filter(s => s.length > 0);

    // Find the most representative embedding for the file.
    // Prefer the summary entry (chunkStart: 0) or fallback to the first content chunk.
	    const representativeEntry = sourceEntries.find(e => e.chunkStart === 0 && e.chunkEnd === 0) || sourceEntries[0];
	    
	    const sourceEmb = typeof representativeEntry.embedding === "string"
	      ? decompressEmbeddingToInt8(representativeEntry.embedding)
	      : representativeEntry.embedding;

    const pathScores = new Map<string, number>();

    for (const entry of this.index) {
      if (entry.path === activeFilePath) continue; // Skip source file

      // Check exclusions
      if (excludedPrefixes.some(prefix => entry.path.startsWith(prefix))) {
        continue;
      }

	      const emb = typeof entry.embedding === "string"
	        ? decompressEmbeddingToInt8(entry.embedding)
	        : entry.embedding;
	      
	      const score = cosineSimilarityInt8(sourceEmb, emb);
      
      const currentMax = pathScores.get(entry.path) || 0;
      if (score > currentMax) {
        pathScores.set(entry.path, score);
      }
    }
    
    return Array.from(pathScores.entries())
      .map(([path, score]) => ({ path, score }))
      .filter(s => s.score >= this.plugin.settings.connectionsThreshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, this.plugin.settings.connectionsMaxResults);
  }
}
