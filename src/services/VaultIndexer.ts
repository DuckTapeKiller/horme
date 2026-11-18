import { TFile, Notice, Platform, normalizePath } from "obsidian";
import { minimatch } from "minimatch";
import HormePlugin from "../../main";
import {
  chunkHash,
  extractHeadings,
  headingPathAtOffset,
  highlightsText,
  parseGlobList,
} from "../utils/noteText";
import { HormeErrorModal } from "../modals/HormeErrorModal";
import { EmbeddingService } from "./EmbeddingService";
import {
  compressEmbedding,
  decompressEmbeddingToInt8,
  getModelPrefixes,
  quantizeEmbeddingToInt8,
} from "../utils/VectorUtils";
import {
  asArray,
  asNumberArray,
  errorToMessage,
  getNumberProp,
  getRecordProp,
  getStringProp,
} from "../utils/TypeGuards";

export interface IndexEntry {
  path: string;
  chunkStart: number;
  chunkEnd: number;
  embedding: Int8Array | string;
  mtime: number;
  /** Stable content hash for incremental chunk-level reuse (may be absent in older indexes). */
  chunkHash?: string;
  entryType?: "content" | "summary" | "highlights";
  summaryText?: string;
  tagsText?: string;
  highlightsText?: string;
  headingPath?: string;
}

export type TextExtractorApi = {
  extractText: (file: TFile) => Promise<string>;
  canFileBeExtracted?: (filePath: string) => boolean;
  isInCache?: (file: TFile) => Promise<boolean>;
};

export class VaultIndexer {
  private plugin: HormePlugin;
  public index: IndexEntry[] = [];
  /** Entries by note path, kept in step with `index`. */
  readonly pathIndex: Map<string, IndexEntry[]> = new Map();
  public indexedModel: string = "";
  public loadWasPartial: boolean = false;
  private isSaving: boolean = false;
  private pendingSave: boolean = false;
  private lastShardSaveTime: number = 0;
  private indexPath: string;

  /** O(1) lookup of entries by path */
  getEntriesForPath(path: string): IndexEntry[] {
    return this.pathIndex.get(path) || [];
  }

  /** Removes all entries for a given path from both the flat array and the Map */
  public removeEntriesForPath(path: string): void {
    const existing = this.pathIndex.get(path);
    if (!existing || existing.length === 0) return;
    const pathSet = new Set(existing);

    let writeIndex = 0;
    for (let i = 0; i < this.index.length; i++) {
      if (!pathSet.has(this.index[i])) {
        this.index[writeIndex++] = this.index[i];
      }
    }
    this.index.length = writeIndex;

    this.pathIndex.delete(path);
    this.changes++;
  }

  /**
   * Counts changes to the index in memory, so a pass that changed nothing (a
   * note that failed to embed, an edit that was already indexed) writes
   * nothing: saving rewrites every shard.
   */
  private changes = 0;

  private forgetSaveTimer: number | null = null;

  /**
   * A note was deleted or renamed: its passages leave the index on disk too.
   * (They used to leave memory only, came back at the next start, and were
   * offered as sources for notes that no longer exist.)
   */
  public forgetNote(path: string): void {
    if (!this.pathIndex.get(path)?.length) return;
    this.removeEntriesForPath(path);
    // Several deletions at once (a folder) are saved together.
    if (this.forgetSaveTimer !== null) window.clearTimeout(this.forgetSaveTimer);
    this.forgetSaveTimer = window.setTimeout(() => {
      this.forgetSaveTimer = null;
      void this.saveIndex().catch((e: unknown) => {
        this.plugin.diagnosticService.report(
          "Vault Brain",
          `Saving after a deletion failed: ${errorToMessage(e)}`,
        );
      });
    }, 2000);
  }

  /**
   * Brings the saved index in line with the vault once both have loaded,
   * after a time Horme was not running: queues notes added or changed
   * meanwhile, and, on a computer, drops notes deleted meanwhile. A phone or
   * tablet never drops anything: it often holds only part of the vault
   * (selective sync), and a note it lacks may well exist on the computer that
   * built the index. Run once, when the workspace is ready.
   */
  async reconcileWithVault(): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (!this.isLoaded && Date.now() < deadline) {
      await new Promise<void>((r) => window.setTimeout(r, 200));
    }
    if (!this.isLoaded || this.loadWasPartial) return;
    if (!Platform.isMobile) await this.pruneVanishedNotes();
    this.queueMissedNotes();
  }

  /**
   * Drops the passages of notes that no longer exist, deleted or moved while
   * Obsidian was closed (or while it was open, before forgetNote saved).
   * Changes nothing when more than half of the indexed notes look missing: a
   * vault still loading or a folder offline. Returns how many notes were dropped.
   */
  private async pruneVanishedNotes(): Promise<number> {
    if (this.isIndexing || this.pathIndex.size === 0) return 0;
    const vault = this.plugin.app.vault;
    const missing = [...this.pathIndex.keys()].filter(
      (p) => !(vault.getAbstractFileByPath(p) instanceof TFile),
    );
    if (missing.length === 0) return 0;
    if (missing.length > this.pathIndex.size / 2) {
      this.plugin.diagnosticService.report(
        "Vault Brain",
        `${missing.length} of ${this.pathIndex.size} indexed notes were not found; the index was left as it is. Rebuild it if those notes are really gone.`,
        "warning",
      );
      return 0;
    }
    let passages = 0;
    for (const p of missing) {
      passages += this.pathIndex.get(p)?.length ?? 0;
      this.removeEntriesForPath(p);
    }
    await this.saveIndex();
    this.plugin.diagnosticService.report(
      "Vault Brain",
      `Removed ${passages} passages of ${missing.length} notes that no longer exist.`,
      "info",
    );
    return missing.length;
  }

  /**
   * Queues the notes to index that the index lacks or holds an older version
   * of: added or changed while Horme was not running, or back on this device
   * after being missing. Unchanged passages keep their vectors (chunk hashes),
   * so a note that only came back is read again, not embedded again.
   */
  private queueMissedNotes(): number {
    if (!this.plugin.settings.vaultBrainEnabled || this.plugin.embeddingBlock() !== null) return 0;
    if (this.isIndexing || this.index.length === 0 || !this.isSpaceCompatible()) return 0;
    const queued = new Set(this.indexingQueue.map((f) => f.path));
    const missed = this.filesToIndex().filter((f) => {
      if (f.stat.size === 0 || queued.has(f.path)) return false;
      const entries = this.pathIndex.get(f.path);
      return !entries?.length || entries[0].mtime < f.stat.mtime;
    });
    if (missed.length === 0) return 0;
    this.indexingQueue.push(...missed);
    this.plugin.diagnosticService.report(
      "Vault Brain",
      `Indexing ${missed.length} ${missed.length === 1 ? "note" : "notes"} added or changed while Horme was not running.`,
      "info",
    );
    void this.processQueue().catch((e: unknown) => {
      this.plugin.diagnosticService.report(
        "Vault Brain",
        `Queue processing failed: ${errorToMessage(e)}`,
        "warning",
      );
    });
    return missed.length;
  }

  /** Adds entries and updates the Map */
  private addEntries(entries: IndexEntry[]): void {
    if (entries.length > 0) this.changes++;
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
    this.changes++;
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

    // ONE-TIME SANITISATION MIGRATION:
    // Wipes corrupted tags generated by the old regex parser in previous versions.
    if (!this.plugin.settings.tagCacheSanitised) {
      this.plugin.debugLog("Horme Brain: Performing one-time sanitisation of tag translation cache.");
      this.plugin.settings.tagCacheSanitised = true;
      void this.plugin.saveSettings();
    }

    // Explicitly resolve the plugin directory relative to the vault root
    const configDir = this.plugin.app.vault.configDir;
    this.indexPath = normalizePath(
      `${configDir}/plugins/${this.plugin.manifest.id}/Vault Index/vault-index.json`,
    );
    this.plugin.debugLog(`Horme Brain: Initializing index at ${this.indexPath}`);
    void this.loadIndex();

    // When the embedding set-up changes (another model, or another local
    // server), the stored vectors no longer match new ones. The index is kept,
    // so switching back restores it, but it is neither searched nor extended
    // until it matches again or is rebuilt.
    this.plugin.onSettingsChange(() => this.checkEmbeddingSpace(true));
  }

  private readonly SHARD_SIZE = 5000;

  private embeddingServerLabel(): string {
    const s = this.plugin.settings;
    const p = this.plugin.embeddingService.embeddingProvider();
    if (p === "llamacpp") return `the llama.cpp embedding server at ${s.llamaCppEmbeddingUrl}`;
    if (p === "lmstudio") return `LM Studio at ${s.lmStudioUrl}`;
    if (p === "custom") return `the OpenAI-compatible server at ${s.customUrl || "(no address)"}`;
    return `Ollama at ${s.ollamaBaseUrl} with "${s.ragEmbeddingModel || "nomic-embed-text"}"`;
  }
  private spaceMismatchNotified = false;

  /** True when the stored vectors were made by the current embedding set-up. */
  isSpaceCompatible(): boolean {
    if (this.index.length === 0) return true;
    return EmbeddingService.sameSpace(this.indexedModel, this.plugin.embeddingService.embeddingFingerprint());
  }

  checkEmbeddingSpace(notify: boolean): void {
    if (this.isSpaceCompatible()) {
      this.spaceMismatchNotified = false;
      return;
    }
    // Only worth saying while Vault Brain can be used: switching the chat to a
    // cloud provider for a moment (which pauses Vault Brain) is not news.
    const usable =
      this.plugin.settings.vaultBrainEnabled &&
      (this.plugin.isLocalProviderActive() || this.plugin.settings.allowCloudRAG);
    if (!usable || this.spaceMismatchNotified) return;
    this.spaceMismatchNotified = true;
    const message = `The embedding set-up changed (${this.indexedModel} → ${this.plugin.embeddingService.embeddingFingerprint()}). The vault index is kept but not searched until you switch back or rebuild it.`;
    this.plugin.diagnosticService.report("Vault Brain", message, "warning");
    if (notify) new Notice(`Vault Brain: ${message}`, 10000);
  }

  /** The label written with the index: the current set-up, unless the index still holds another one's vectors. */
  private spaceLabel(): string {
    return this.isSpaceCompatible() ? this.plugin.embeddingService.embeddingFingerprint() : this.indexedModel;
  }

  private getShardPath(shardIndex: number): string {
    const configDir = this.plugin.app.vault.configDir;
    return normalizePath(
      `${configDir}/plugins/${this.plugin.manifest.id}/Vault Index/vault-index-shard-${String(shardIndex).padStart(3, "0")}.json`,
    );
  }

  private async loadIndex(): Promise<void> {
    try {
      await this.plugin.tagTranslator.loadTagCache();
      this.plugin.setIndexingStatus("Loading Vault Index...");
      // New sharded format: look for the first shard file
      if (await this.plugin.app.vault.adapter.exists(this.getShardPath(0))) {
        await this.loadShardedIndex();
        return;
      }

      // Old monolithic format: migrate and delete the old file
      if (await this.plugin.app.vault.adapter.exists(this.indexPath)) {
        this.plugin.debugLog("Horme Brain: Migrating from monolithic to sharded index...");
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
          this.indexedModel = this.plugin.embeddingService.upgradeLegacyLabel(this.indexedModel);
        }

        // Save in new sharded format and remove the old monolithic file
        await this.saveIndex();
        await this.plugin.app.vault.adapter.remove(this.indexPath);
        this.plugin.debugLog(
          `Horme Brain: Migration complete. ${this.index.length} entries across ${Math.ceil(this.index.length / this.SHARD_SIZE)} shards.`,
        );
        return;
      }

      this.plugin.debugLog("Horme Brain: No existing index found.");
    } catch (e: unknown) {
      this.plugin.diagnosticService.report("Vault Brain", `Critical load failure: ${errorToMessage(e)}`);
      this.clearIndex();
    } finally {
      this.isLoaded = true;
      this.plugin.setIndexingStatus(null);
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

      // RESTORED: Decompress into binary memory immediately on load
      if (typeof embeddingUnknown === "string") embedding = decompressEmbeddingToInt8(embeddingUnknown);
      else {
        const embArr = asNumberArray(embeddingUnknown);
        if (embArr) embedding = quantizeEmbeddingToInt8(embArr);
      }

      const summaryText = getStringProp(e, "summaryText");
      const tagsText = getStringProp(e, "tagsText");
      const highlightsText = getStringProp(e, "highlightsText");
      const headingPath = getStringProp(e, "headingPath");
      const chunkHash = getStringProp(e, "chunkHash");
      const entryTypeProp = getStringProp(e, "entryType");
      const entryType: IndexEntry["entryType"] =
        entryTypeProp === "content" || entryTypeProp === "summary" || entryTypeProp === "highlights"
          ? entryTypeProp
          : chunkStart === 0 && chunkEnd === 0
            ? summaryText || tagsText
              ? "summary"
              : highlightsText
                ? "highlights"
                : undefined
            : undefined;

      out.push({
        path,
        chunkStart,
        chunkEnd,
        embedding,
        mtime,
        ...(chunkHash ? { chunkHash } : {}),
        ...(entryType ? { entryType } : {}),
        ...(summaryText ? { summaryText } : {}),
        ...(tagsText ? { tagsText } : {}),
        ...(highlightsText ? { highlightsText } : {}),
        ...(headingPath ? { headingPath } : {}),
      });
    }
    return out;
  }

  private async loadShardedIndex(): Promise<void> {
    this.clearIndex();
    const adapter = this.plugin.app.vault.adapter;
    // Best-effort recovery from a previously interrupted save.
    // Ensures we don't silently stop at the first missing shard and accidentally run on a truncated index.
    const folderPath = this.getVaultIndexFolderPath();
    await this.reconcileShardArtifacts(folderPath);

    let expectedTotalShards = 0;
    let loadedShards = 0;
    let partialLoadFailed = false;
    let failedShardInfo: { shard: number; path: string } | null = null;

    const failLoad = (shard: number, path: string, reason: string) => {
      this.plugin.diagnosticService.report("Vault Brain", reason, "error");
      partialLoadFailed = true;
      failedShardInfo = { shard, path };
    };

    // ── Load shard 0 first to determine totalShards ──
    try {
      const shard0Path = this.getShardPath(0);
      this.plugin.setIndexingStatus("Loading Brain: Shard 0...");
      const data = await adapter.read(shard0Path);
      const parsed: unknown = JSON.parse(data);

      this.indexedModel = getStringProp(parsed, "model") ?? "";

      const shardProp = getNumberProp(parsed, "shard");
      const totalProp = getNumberProp(parsed, "totalShards");

      const totalValid =
        totalProp !== undefined && Number.isInteger(totalProp) && totalProp >= 1 && totalProp <= 10_000; // sanity cap: prevents runaway loops on corrupted metadata

      if (shardProp !== 0 || !totalValid) {
        failLoad(
          0,
          shard0Path,
          `Shard 0 metadata invalid. shard=${String(shardProp)} totalShards=${String(totalProp)}`,
        );
      } else {
        // In this branch totalValid is true, so totalProp is defined; `?? 0` keeps the
        // type `number` without a redundant assertion.
        expectedTotalShards = totalProp ?? 0;
        const decompressed = this.parseEntries(getRecordProp(parsed, "entries"));
        this.index = this.index.concat(decompressed);
        loadedShards = 1;
      }
    } catch (e: unknown) {
      failLoad(0, this.getShardPath(0), `Failed to read index shard 0: ${errorToMessage(e)}`);
    }

    // ── Load the remaining shards strictly (no "stop early") ──
    if (!partialLoadFailed) {
      for (let shardIndex = 1; shardIndex < expectedTotalShards; shardIndex++) {
        const path = this.getShardPath(shardIndex);
        this.plugin.setIndexingStatus(`Loading Brain: Shard ${shardIndex}...`);

        try {
          const data = await adapter.read(path);
          const parsed: unknown = JSON.parse(data);

          const modelProp = getStringProp(parsed, "model") ?? "";
          const shardProp = getNumberProp(parsed, "shard");
          const totalProp = getNumberProp(parsed, "totalShards");

          if (
            modelProp !== this.indexedModel ||
            shardProp !== shardIndex ||
            totalProp !== expectedTotalShards
          ) {
            failLoad(
              shardIndex,
              path,
              `Shard metadata mismatch. shard=${String(shardProp)} totalShards=${String(
                totalProp,
              )} model=${modelProp || "(missing)"}`,
            );
            break;
          }

          const decompressed = this.parseEntries(getRecordProp(parsed, "entries"));
          this.index = this.index.concat(decompressed);
          loadedShards++;
        } catch (e: unknown) {
          failLoad(shardIndex, path, `Failed to read index shard ${shardIndex}: ${errorToMessage(e)}`);
          break;
        }
      }
    }

    if (partialLoadFailed && failedShardInfo) {
      this.loadWasPartial = true;
      this.indexedModel = "";
      this.clearIndex();

      // Some TS configurations can fail to narrow captured variables across complex async control flow.
      // Capture the non-null value explicitly to keep the type stable.
      const info = failedShardInfo as { shard: number; path: string };
      const errorMsg = `The Vault Brain index failed to load completely.\n\nShard: ${info.shard}\nPath: ${info.path}\n\nTo prevent data loss or silently operating on truncated/corrupted search indexes, the in-memory index has been cleared. Please perform a full rebuild of the Vault Index to restore search functionality.`;

      new HormeErrorModal(this.plugin.app, "Vault Index Load Failure", errorMsg).open();
      return;
    }

    this.loadWasPartial = false;
    this.rebuildPathIndex();
    // Older indexes were labelled with the Ollama model setting only.
    this.indexedModel = this.plugin.embeddingService.upgradeLegacyLabel(this.indexedModel);
    this.checkEmbeddingSpace(false);
    this.plugin.debugLog(
      `Horme Brain: Loaded ${this.index.length} entries from ${loadedShards} shards (model: ${this.indexedModel}).`,
    );
  }

  private async saveIndex(): Promise<void> {
    if (this.loadWasPartial) {
      const errMsg =
        "Refusing to save index because the last index load was partial (shard failure). Saving now would corrupt/truncate the stored index.";
      this.plugin.diagnosticService.report("Vault Brain", errMsg, "error");
      console.error(`Horme Brain: ${errMsg}`);
      return;
    }

    if (this.isSaving) {
      this.pendingSave = true;
      return;
    }

    this.isSaving = true;

    try {
      try {
        const adapter = this.plugin.app.vault.adapter;
        const configDir = this.plugin.app.vault.configDir;
        const folderPath = normalizePath(`${configDir}/plugins/${this.plugin.manifest.id}/Vault Index`);
        if (!(await adapter.exists(folderPath))) await adapter.mkdir(folderPath);

        // Best-effort recovery/cleanup if a previous save was interrupted.
        await this.reconcileShardArtifacts(folderPath);

        const currentModel = this.spaceLabel();
        // Snapshot: a delete or rename during the awaits below must not shift
        // entries between shards.
        const snapshot = this.index.slice();
        const totalShards = Math.max(1, Math.ceil(snapshot.length / this.SHARD_SIZE));

        // ── Phase 1: Write all shards to temporary files ──
        // If the process crashes here, only .tmp files are affected;
        // the previous valid shards remain untouched on disk.
        const tmpPaths: string[] = [];
        const finalPaths: string[] = [];

        for (let i = 0; i < totalShards; i++) {
          const shardEntries = snapshot.slice(i * this.SHARD_SIZE, (i + 1) * this.SHARD_SIZE).map((e) => ({
            path: e.path,
            chunkStart: e.chunkStart,
            chunkEnd: e.chunkEnd,
            embedding: typeof e.embedding === "string" ? e.embedding : compressEmbedding(e.embedding),
            mtime: e.mtime,
            ...(e.chunkHash ? { chunkHash: e.chunkHash } : {}),
            ...(e.entryType ? { entryType: e.entryType } : {}),
            ...(e.summaryText ? { summaryText: e.summaryText } : {}),
            ...(e.tagsText ? { tagsText: e.tagsText } : {}),
            ...(e.highlightsText ? { highlightsText: e.highlightsText } : {}),
            ...(e.headingPath ? { headingPath: e.headingPath } : {}),
          }));

          const shardData = JSON.stringify({
            model: currentModel,
            shard: i,
            totalShards,
            entries: shardEntries,
          });

          const finalPath = this.getShardPath(i);
          const tmpPath = finalPath + ".tmp";
          await adapter.write(tmpPath, shardData);
          tmpPaths.push(tmpPath);
          finalPaths.push(finalPath);
        }

        // ── Phase 2: Atomic rename pass ──
        // Safer swap: final → .bak, tmp → final. Keep .bak until the end so
        // an interrupted save can be rolled back to a consistent prior snapshot.
        for (let i = 0; i < tmpPaths.length; i++) {
          const finalPath = finalPaths[i];
          const tmpPath = tmpPaths[i];
          const bakPath = finalPath + ".bak";

          // adapter.rename() does not overwrite on all platforms, so ensure target is clear
          if (await adapter.exists(bakPath)) await adapter.remove(bakPath);

          if (await adapter.exists(finalPath)) {
            await adapter.rename(finalPath, bakPath);
          }

          await adapter.rename(tmpPath, finalPath);
        }

        // Clean up backups after a fully successful swap pass
        for (let i = 0; i < finalPaths.length; i++) {
          const bakPath = finalPaths[i] + ".bak";
          if (await adapter.exists(bakPath)) await adapter.remove(bakPath);
        }

        // ── Phase 3: Clean up stale shards from a previously larger index ──
        for (let i = totalShards; ; i++) {
          const stalePath = this.getShardPath(i);
          if (await adapter.exists(stalePath)) {
            await adapter.remove(stalePath);
          } else {
            break;
          }
        }

        // Clean up any orphaned .tmp/.bak files from a previously interrupted save
        const listed = await adapter.list(folderPath);
        for (const f of listed.files) {
          if (f.endsWith(".tmp") || f.endsWith(".bak")) {
            await adapter.remove(f);
          }
        }

        this.indexedModel = currentModel;
      } catch (e: unknown) {
        this.plugin.diagnosticService.report("Vault Brain", `Critical save failure: ${errorToMessage(e)}`);
        new HormeErrorModal(
          this.plugin.app,
          "Vault Brain: Index save failed",
          "Horme could not save the vault index to disk. Indexing has been paused to prevent data loss.",
          String(e),
        ).open();
      }
    } finally {
      this.isSaving = false;
      if (this.pendingSave) {
        this.pendingSave = false;
        void this.saveIndex().catch((e: unknown) => {
          this.plugin.diagnosticService.report("Vault Brain", `Deferred save failed: ${errorToMessage(e)}`);
        });
      }
    }
  }

  private getVaultIndexFolderPath(): string {
    const configDir = this.plugin.app.vault.configDir;
    return normalizePath(`${configDir}/plugins/${this.plugin.manifest.id}/Vault Index`);
  }

  async hasBuiltIndex(): Promise<boolean> {
    if (this.index.length > 0) return true;
    const adapter = this.plugin.app.vault.adapter;

    try {
      if (await adapter.exists(this.getShardPath(0))) return true;
      if (await adapter.exists(this.indexPath)) return true;
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
    const shardFiles = listed.files.filter((path) =>
      /vault-index-shard-\d+\.json(\.tmp|\.bak)?$/i.test(path),
    );

    for (const path of shardFiles) {
      await adapter.remove(path);
    }
    return shardFiles.length;
  }

  /**
   * Best-effort recovery/cleanup for shard saves that were interrupted mid-commit.
   *
   * Cases handled:
   * - `.tmp` present: treat as interrupted save and roll back any swapped shards by restoring `.bak` → final,
   *   then remove `.tmp`.
   * - `.bak` present but no `.tmp`: treat as a completed save where cleanup didn't finish; remove `.bak`.
   */
  private async reconcileShardArtifacts(folderPath: string): Promise<void> {
    const adapter = this.plugin.app.vault.adapter;
    if (!(await adapter.exists(folderPath))) return;

    try {
      const listed = await adapter.list(folderPath);
      const bakFiles = listed.files.filter((p) => /vault-index-shard-\d+\.json\.bak$/i.test(p));
      const tmpFiles = listed.files.filter((p) => /vault-index-shard-\d+\.json\.tmp$/i.test(p));
      if (bakFiles.length === 0 && tmpFiles.length === 0) return;

      // If any `.tmp` exists, assume the commit pass did not complete. Prefer consistency by rolling back.
      if (tmpFiles.length > 0) {
        for (const bakPath of bakFiles) {
          const finalPath = bakPath.replace(/\.bak$/i, "");
          try {
            if (await adapter.exists(finalPath)) await adapter.remove(finalPath);
            await adapter.rename(bakPath, finalPath);
          } catch (e: unknown) {
            this.plugin.diagnosticService.report(
              "Vault Brain",
              `Failed to restore shard backup: ${bakPath} (${errorToMessage(e)})`,
              "warning",
            );
          }
        }
      } else {
        // No `.tmp`: cleanup leftover backups without touching the committed shards.
        for (const bakPath of bakFiles) {
          try {
            await adapter.remove(bakPath);
          } catch (e: unknown) {
            this.plugin.diagnosticService.report(
              "Vault Brain",
              `Failed to delete shard backup: ${bakPath} (${errorToMessage(e)})`,
              "warning",
            );
          }
        }
      }

      // Always delete orphaned `.tmp` (never considered committed).
      for (const tmpPath of tmpFiles) {
        try {
          await adapter.remove(tmpPath);
        } catch (e: unknown) {
          this.plugin.diagnosticService.report(
            "Vault Brain",
            `Failed to delete shard temp file: ${tmpPath} (${errorToMessage(e)})`,
            "warning",
          );
        }
      }
    } catch (e: unknown) {
      this.plugin.diagnosticService.report(
        "Vault Brain",
        `Failed to reconcile shard artifacts: ${errorToMessage(e)}`,
        "warning",
      );
    }
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
      await this.plugin.tagTranslator.forgetAll();
      this.indexedModel = "";
      this.loadWasPartial = false;
      this.plugin.settings.indexStatus = "Not built";
      await this.plugin.saveSettings();
      this.plugin.setIndexingStatus(null);

      if (hadInMemory || hadLegacy || removedShardCount > 0) {
        this.plugin.diagnosticService.report("Vault Brain", "Vault index deleted by user.", "info");
        return "deleted";
      }
      this.plugin.diagnosticService.report(
        "Vault Brain",
        "Delete requested, but no vault index was found.",
        "info",
      );
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
    this.plugin.debugLog("Horme Brain: Obsidian closing mid-index — flushing progress...");
    this.plugin.settings.indexStatus = "Interrupted — resume rebuild to continue";
    void this.plugin.saveSettings().catch((e) => this.plugin.handleError(e, "Vault Brain"));
    this.saveIndex()
      .then(() => this.plugin.debugLog("Horme Brain: Emergency flush complete."))
      .catch((e: unknown) => {
        console.error("Horme Brain: Emergency flush failed.", e);
        this.plugin.diagnosticService.report("Vault Brain", `Emergency flush failed: ${errorToMessage(e)}`);
      });
  }

  isIndexing = false;
  public isLoaded = false;

  private extractFrontmatterSummary(
    content: string,
    file: TFile,
  ): { fullText: string; summaryOnly: string; tagsOnly: string } | null {
    const cache = this.plugin.app.metadataCache.getFileCache(file);
    const frontmatter: Record<string, unknown> | undefined = cache?.frontmatter;

    let summaryOnly = "";
    if (frontmatter) {
      const summaryKeys = ["resumen", "summary", "description", "abstract", "Resumen", "Summary"];
      for (const key of summaryKeys) {
        if (frontmatter[key] && typeof frontmatter[key] === "string") {
          summaryOnly = frontmatter[key].trim();
          break;
        }
      }
    }

    const tags = this.plugin.tagTranslator.collectShadowTags(content, file);
    let tagsOnly = "";

    if (tags.length > 0) {
      tagsOnly = tags.map((t) => this.plugin.tagTranslator.translateTagsBilingually(t)).join(", ");
    }

    if (!summaryOnly && !tagsOnly) return null;

    const parts: string[] = [`${file.basename}`];
    if (summaryOnly) parts.push(summaryOnly);
    if (tagsOnly) parts.push("Temas: " + tagsOnly);

    if (frontmatter) {
      const authorValue = frontmatter.autor || frontmatter.Autor || frontmatter.author || frontmatter.Author;
      if (authorValue) {
        if (typeof authorValue === "string") {
          parts.push("Autor: " + authorValue.trim());
        } else if (Array.isArray(authorValue)) {
          parts.push("Autor: " + authorValue.map((a) => String(a).trim()).join(", "));
        }
      }
    }

    return {
      fullText: `${getModelPrefixes(this.plugin.embeddingService.embeddingModelName()).doc}${parts.join("\n")}`,
      summaryOnly,
      tagsOnly,
    };
  }

  /** The note's ==highlights== as one entry's text, when highlights are indexed. */
  private highlightsOf(content: string): string | null {
    const s = this.plugin.settings;
    if (!s.indexHighlightsEnabled) return null;
    return highlightsText(content, {
      maxHighlights: s.maxHighlightsPerNote,
      maxChars: s.maxHighlightCharsPerNote,
    });
  }

  getTextExtractorApi(): TextExtractorApi | undefined {
    // Optional dependency: community plugin "Text Extractor" (id: "text-extractor").
    // `app.plugins` is not part of Obsidian's public typings, so describe just the
    // shape we read instead of reaching through `any`.
    const internalApp = this.plugin.app as unknown as {
      plugins?: { plugins?: Record<string, { api?: TextExtractorApi } | undefined> };
    };
    return internalApp.plugins?.plugins?.["text-extractor"]?.api;
  }

  private isPathIndexableByPatterns(path: string): boolean {
    const include = parseGlobList(this.plugin.settings.vaultIndexIncludePatterns || "");
    const exclude = parseGlobList(this.plugin.settings.vaultIndexExcludePatterns || "");

    const opts = { dot: true };
    if (exclude.some((p) => minimatch(path, p, opts))) return false;
    if (include.length === 0) return true;
    return include.some((p) => minimatch(path, p, opts));
  }

  private filterFilesForIndexing(files: TFile[]): TFile[] {
    // Patterns apply to vault-relative paths, e.g. "Music/Note.md"
    return files.filter((f) => this.isPathIndexableByPatterns(f.path));
  }

  /** True when Vault Brain indexes this file (see filesToIndex). */
  indexes(file: TFile): boolean {
    if (!this.isPathIndexableByPatterns(file.path)) return false;
    const ext = file.extension.toLowerCase();
    if (ext === "md") return true;
    if (ext !== "pdf" || !this.plugin.settings.vaultIndexIndexPdf) return false;
    const textExtractor = this.getTextExtractorApi();
    if (!textExtractor) return false;
    return textExtractor.canFileBeExtracted ? textExtractor.canFileBeExtracted(file.path) : true;
  }

  /**
   * The files Vault Brain indexes: every note, and PDFs when asked for and
   * Text Extractor can read them, filtered by the include and leave-out patterns.
   */
  private filesToIndex(): TFile[] {
    const textExtractor = this.getTextExtractorApi();
    const pdfFiles =
      this.plugin.settings.vaultIndexIndexPdf && textExtractor
        ? this.plugin.app.vault
            .getFiles()
            .filter((f) => f.extension.toLowerCase() === "pdf")
            .filter((f) =>
              textExtractor.canFileBeExtracted ? textExtractor.canFileBeExtracted(f.path) : true,
            )
        : [];
    return this.filterFilesForIndexing([...this.plugin.app.vault.getMarkdownFiles(), ...pdfFiles]);
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
    this.loadWasPartial = false; // Reset partial load flag since we are doing a full rebuild

    this.plugin.tagTranslator.startRun();
    this.lastShardSaveTime = 0;

    try {
      this.plugin.setIndexingStatus("Initializing Index Rebuild...");

      // Privacy guard: indexing sends the full text of every note to the
      // embedding server, so it runs only when that server is the user's own
      // (whatever answers the chat). Summaries are extracted locally; tag
      // translation has its own consent.
      const block = this.plugin.embeddingBlock();
      if (block) {
        new Notice(`Horme: ${block}`, 10000);
        return;
      }
      if (
        this.plugin.embeddingService.embeddingProvider() === "ollama" &&
        !this.plugin.settings.ragEmbeddingModel
      ) {
        new Notice("Vault Brain: No embedding model selected.");
        return;
      }
      if (!this.plugin.settings.vaultBrainEnabled) {
        new Notice("Vault Brain: Vault Brain is disabled in settings.");
        return;
      }

      // The index loads in the background at start-up; a rebuild that began
      // before it finished would be overwritten by the load.
      const loadDeadline = Date.now() + 60_000;
      while (!this.isLoaded && Date.now() < loadDeadline) {
        await new Promise<void>((r) => window.setTimeout(r, 200));
      }

      // Vectors from another embedding set-up cannot be reused or kept. The
      // model is detected first, so the label names it.
      await this.plugin.embeddingService.resolveEmbeddingModelName();
      if (!this.isSpaceCompatible()) this.clearIndex();
      this.indexedModel = this.plugin.embeddingService.embeddingFingerprint();
      this.spaceMismatchNotified = false;

      const textExtractor = this.getTextExtractorApi();
      if (this.plugin.settings.vaultIndexIndexPdf && !textExtractor) {
        this.plugin.diagnosticService.report(
          "Vault Brain",
          'PDF indexing is enabled, but the companion plugin "Text Extractor" (id: text-extractor) is not available. PDFs will be skipped.',
          "warning",
        );
      }

      const files = this.filesToIndex();
      const total = files.length;
      this.plugin.debugLog(`Horme Brain: Rebuilding index for ${total} files...`);

      // Purge orphaned entries for files that were deleted or renamed while inactive
      const validPaths = new Set(files.map((f) => f.path));
      const knownPaths = Array.from(this.pathIndex.keys());
      for (const path of knownPaths) {
        if (!validPaths.has(path)) {
          this.removeEntriesForPath(path);
        }
      }

      let updatedCount = 0;
      let consecutiveErrors = 0;

      this.plugin.settings.indexStatus = `Indexing (0/${total})...`;
      await this.plugin.saveSettings();
      this.plugin.setIndexingStatus(`Indexing 0 / ${total}`);

      // Pre-translate tags for Markdown files only (PDFs have no tags/frontmatter).
      await this.plugin.tagTranslator.preTranslateTags(
        files.filter((f) => f.extension.toLowerCase() === "md"),
      );

      for (let i = 0; i < total; i++) {
        const file = files[i];

        // Update the status bar for every single file so the UI feels responsive
        this.plugin.settings.indexStatus = `Indexing (${i + 1}/${total}): ${file.name.slice(0, 20)}...`;
        this.plugin.setIndexingStatus(`Indexing ${i + 1} / ${total}`);

        const existing = this.getEntriesForPath(file.path);
        if (existing.length > 0 && existing[0].mtime >= file.stat.mtime) {
          continue;
        }

        // Chunk-hash based reuse map (only effective after at least one hash-aware build)
        const existingEmbeddingByHash = new Map<string, Int8Array>();
        for (const e of existing) {
          if (!e.chunkHash) continue;
          const emb = typeof e.embedding === "string" ? decompressEmbeddingToInt8(e.embedding) : e.embedding;
          existingEmbeddingByHash.set(e.chunkHash, emb);
        }

        // The version being read: an edit made while this file is embedded
        // leaves the entries older than the file, so the edit is indexed next.
        const mtimeAtRead = file.stat.mtime;
        try {
          const isPdf = file.extension.toLowerCase() === "pdf";
          let content = "";
          if (isPdf) {
            if (!textExtractor) {
              this.removeEntriesForPath(file.path);
              continue;
            }
            content = (await textExtractor.extractText(file)) || "";
            const maxChars = Math.max(10_000, this.plugin.settings.vaultIndexPdfMaxChars || 0);
            if (content.length > maxChars) content = content.slice(0, maxChars);
          } else {
            content = await this.plugin.app.vault.read(file);
          }
          if (!content.trim()) {
            this.removeEntriesForPath(file.path);
            continue;
          }

          const chunksWithOffsets = this.plugin.embeddingService.chunkTextWithOffsets(content);
          const validChunks = chunksWithOffsets.filter((c) => c.text.trim().length > 0);

          // Frontmatter summaries/tags only exist for Markdown notes.
          const fmData = isPdf ? null : this.extractFrontmatterSummary(content, file);
          const hasFmSummary = fmData !== null;

          if (validChunks.length > 0 || hasFmSummary) {
            // Extract heading structure for heading-aware chunking
            const headings = isPdf ? [] : extractHeadings(content);
            const bilingualTags = fmData?.tagsOnly || "";
            const highlightsOnly = isPdf ? "" : this.highlightsOf(content);
            const hasHighlights = Boolean(highlightsOnly);

            // Build embedding texts with search_document prefix and heading context
            const embeddingTexts = validChunks.map((c) => {
              const hp = headingPathAtOffset(headings, c.start);
              const docPrefix = getModelPrefixes(this.plugin.embeddingService.embeddingModelName()).doc;
              // Prepend bilingual tags to every chunk so the vector captures both languages.
              // Tags are brief (30–80 chars) and won't dilute the body content meaningfully.
              const tagLine = bilingualTags ? `Tags: ${bilingualTags}\n` : "";
              return `${docPrefix}${file.basename}${hp ? " > " + hp : ""}\n${tagLine}\n${c.text}`;
            });

            // Add a dedicated highlights-only embedding per note (note-level entry).
            if (hasHighlights) {
              const docPrefix = getModelPrefixes(this.plugin.embeddingService.embeddingModelName()).doc;
              embeddingTexts.unshift(`${docPrefix}${file.basename}\nHighlights:\n${highlightsOnly}`);
            }

            // Add a dedicated frontmatter summary embedding (offset 0,0 = signals summary entry)
            if (hasFmSummary) embeddingTexts.unshift(fmData.fullText);

            const chunkHashes = embeddingTexts.map((t) => chunkHash(t));

            const resolvedEmbeddings: Array<Int8Array | null> = new Array<Int8Array | null>(
              embeddingTexts.length,
            ).fill(null);
            const toEmbedTexts: string[] = [];
            const toEmbedIndices: number[] = [];

            for (let i = 0; i < embeddingTexts.length; i++) {
              const hash = chunkHashes[i];
              const reused = existingEmbeddingByHash.get(hash);
              if (reused) {
                resolvedEmbeddings[i] = reused;
              } else {
                toEmbedIndices.push(i);
                toEmbedTexts.push(embeddingTexts[i]);
              }
            }

            if (toEmbedTexts.length > 0) {
              const embeddings = await this.plugin.embeddingService.getEmbeddings(toEmbedTexts);

              if (!embeddings || embeddings.length !== toEmbedTexts.length) {
                throw new Error(
                  `API returned ${embeddings?.length || 0} embeddings for ${toEmbedTexts.length} chunks. Cancelling to prevent data loss.`,
                );
              }

              for (let i = 0; i < embeddings.length; i++) {
                const idx = toEmbedIndices[i];
                const emb = embeddings[i];
                if (emb && emb.length > 0) {
                  resolvedEmbeddings[idx] = quantizeEmbeddingToInt8(emb);
                }
              }
            }

            const newEntries: IndexEntry[] = [];
            let cursor = 0;
            if (hasFmSummary) {
              const emb = resolvedEmbeddings[cursor];
              if (emb && emb.length > 0) {
                newEntries.push({
                  path: file.path,
                  chunkStart: 0,
                  chunkEnd: 0,
                  entryType: "summary",
                  embedding: emb,
                  mtime: mtimeAtRead,
                  chunkHash: chunkHashes[cursor],
                  summaryText: fmData.summaryOnly,
                  tagsText: fmData.tagsOnly,
                });
              }
              cursor += 1;
            }

            if (hasHighlights) {
              const emb = resolvedEmbeddings[cursor];
              if (emb && emb.length > 0) {
                newEntries.push({
                  path: file.path,
                  chunkStart: 0,
                  chunkEnd: 0,
                  entryType: "highlights",
                  embedding: emb,
                  mtime: mtimeAtRead,
                  chunkHash: chunkHashes[cursor],
                  highlightsText: highlightsOnly ?? undefined,
                });
              }
              cursor += 1;
            }

            // Store chunk embeddings with heading path
            for (let j = 0; j < validChunks.length; j++) {
              const emb = resolvedEmbeddings[j + cursor];
              if (emb && emb.length > 0) {
                const hp = headingPathAtOffset(headings, validChunks[j].start);
                newEntries.push({
                  path: file.path,
                  chunkStart: validChunks[j].start,
                  chunkEnd: validChunks[j].end,
                  entryType: "content",
                  embedding: emb,
                  mtime: mtimeAtRead,
                  chunkHash: chunkHashes[j + cursor],
                  ...(hp ? { headingPath: hp } : {}),
                  ...(bilingualTags ? { tagsText: bilingualTags } : {}),
                });
              }
            }
            this.removeEntriesForPath(file.path);
            this.addEntries(newEntries);
          } else {
            this.removeEntriesForPath(file.path);
          }
          updatedCount++;
          consecutiveErrors = 0; // reset on success

          // Auto-save checkpoint with a 30-second minimum pacing to prevent progress loss and avoid cloud sync collisions
          const now = Date.now();
          if (now - this.lastShardSaveTime > 30_000) {
            await this.saveIndex();
            this.lastShardSaveTime = Date.now();
          }
        } catch (e: unknown) {
          this.plugin.diagnosticService.report(
            "Vault Brain",
            `Note skipped: ${file.path} (${errorToMessage(e)})`,
            "warning",
          );
          consecutiveErrors++;
          // (e.g. one bad file) should not stop the entire rebuild.
          if (consecutiveErrors > 15) {
            new HormeErrorModal(
              this.plugin.app,
              "Vault Brain: Indexing paused",
              `Indexing stopped after ${consecutiveErrors} consecutive failures. This usually means the embedding server is unreachable or its model is not loaded. Check that ${this.embeddingServerLabel()} is running and serves an embedding model.`,
              `Last error: check the developer console (Ctrl+Shift+I) for details.`,
            ).open();
            this.plugin.settings.indexStatus = "Failed (too many consecutive errors)";
            await this.plugin.saveSettings();

            if (updatedCount > 0) {
              await this.saveIndex();
            }

            return;
          }
        }
      }

      await this.saveIndex();

      this.plugin.tagTranslator.reportRun();

      this.plugin.settings.indexStatus = "Ready";
      await this.plugin.saveSettings();

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
        errorToMessage(e),
      ).open();
    } finally {
      // Acquire the queue lock BEFORE releasing isIndexing to prevent a race
      // where an event-triggered enqueueIndex() calls processQueue() concurrently
      // with the post-rebuild queue drain below.
      const hasQueuedWork = this.indexingQueue.length > 0;
      if (hasQueuedWork) this.isProcessingQueue = true;

      this.isIndexing = false;
      this.plugin.setIndexingStatus(null);

      // Process any files that were modified and queued while the rebuild was running
      if (hasQueuedWork) {
        // isProcessingQueue is already true, so processQueue() will skip its own guard.
        // We drive the loop manually here and release the lock in the finally below.
        try {
          // Release the flag so processQueue() can acquire it normally
          this.isProcessingQueue = false;
          await this.processQueue();
        } catch (e) {
          this.isProcessingQueue = false;
          this.plugin.diagnosticService.report(
            "Vault Brain",
            `Post-rebuild queue failed: ${errorToMessage(e)}`,
            "warning",
          );
        }
      }
    }
  }

  private indexingQueue: TFile[] = [];
  isProcessingQueue = false;

  /**
   * Enqueues a file for indexing.
   */
  async enqueueIndex(file: TFile) {
    // Indexing only reaches the embedding server, never the chat provider, so
    // it is that server that must be usable: the user's own, and reachable
    // from this device (a phone cannot reach the computer's 127.0.0.1). With a
    // cloud chat the index still keeps up with edits (searching it for the
    // chat is gated separately, in search()).
    if (this.plugin.embeddingBlock() !== null || !this.plugin.settings.vaultBrainEnabled) {
      return;
    }
    // Incremental indexing is only allowed after at least one successful full build,
    // and never mixes vectors from another embedding set-up into the index.
    if (!(await this.hasBuiltIndex()) || !this.isSpaceCompatible()) {
      return;
    }

    this.plugin.debugLog(`Horme Brain: Enqueueing ${file.path} for indexing...`);
    if (!this.indexingQueue.some((f) => f.path === file.path)) {
      this.indexingQueue.push(file);
    }
    void this.processQueue().catch((e) => {
      this.plugin.diagnosticService.report(
        "Vault Brain",
        `Queue processing failed: ${errorToMessage(e)}`,
        "warning",
      );
    });
  }

  private async processQueue() {
    // Prevent queue processing if a full rebuild is currently active
    if (this.isProcessingQueue || this.isIndexing) return;
    this.isProcessingQueue = true;

    // Wait for the index to finish loading from disk before processing any changes.
    // If we process and save a partial index during startup, we risk overwriting
    // the full shard files with only the freshly modified notes.
    if (!this.isLoaded) {
      this.plugin.setIndexingStatus("Waiting for brain index...");
      const deadline = Date.now() + 5000;
      while (!this.isLoaded && Date.now() < deadline) {
        await new Promise<void>((r) => window.setTimeout(r, 100));
      }
      if (!this.isLoaded) {
        console.error(
          "Horme Brain: Index failed to load within timeout. Aborting queue to prevent data loss.",
        );
        this.plugin.diagnosticService.report(
          "Vault Brain",
          "Queue aborted: Index failed to load after 5s timeout.",
          "error",
        );
        this.plugin.setIndexingStatus("Index load timeout");
        this.isProcessingQueue = false;
        return;
      }
    }

    try {
      // Guard: if the index loaded only partially, incremental saves are blocked
      // (saveIndex refuses to write). Warn the user instead of silently discarding work.
      if (this.loadWasPartial) {
        this.plugin.debugWarn("Horme Brain: Skipping queue — index loaded partially. Rebuild to restore.");
        this.plugin.diagnosticService.report(
          "Vault Brain",
          "Incremental indexing skipped: index loaded partially. Please rebuild the Vault Brain to restore full functionality.",
          "warning",
        );
        this.isProcessingQueue = false;
        return;
      }

      // The server may have another model loaded since the index was built:
      // its vectors never join the index.
      await this.plugin.embeddingService.resolveEmbeddingModelName();
      if (!this.isSpaceCompatible()) {
        this.indexingQueue = [];
        this.checkEmbeddingSpace(true);
        return;
      }

      let totalQueued = this.indexingQueue.length;
      let processed = 0;
      const changesAtStart = this.changes;

      // Ensure queued files have tags pre-translated to avoid mid-queue VRAM swaps
      if (totalQueued > 0) {
        await this.plugin.tagTranslator.preTranslateTags([...this.indexingQueue]);
      }

      while (this.indexingQueue.length > 0) {
        // Re-check on every iteration: the embedding server may have become unusable since enqueue.
        if (this.plugin.embeddingBlock() !== null || !this.plugin.settings.vaultBrainEnabled) {
          this.plugin.debugLog(
            "Horme Brain: Embedding server no longer allowed during queue processing. Clearing queue.",
          );
          this.indexingQueue = [];
          break;
        }

        totalQueued = Math.max(totalQueued, processed + this.indexingQueue.length);
        const file = this.indexingQueue.shift();
        if (file) {
          processed++;
          this.plugin.setIndexingStatus(`Indexing ${processed} / ${totalQueued}`);

          const didWork = await this.indexFile(file);

          // Only yield 50ms if heavy LLM work was actually done.
          // Otherwise, yield 0ms just to let the DOM repaint the status bar.
          if (didWork) {
            await new Promise<void>((r) => window.setTimeout(r, 50));
          } else if (processed % 50 === 0) {
            await new Promise<void>((r) => window.setTimeout(r, 0));
          }
        }
      }

      // Save once when the queue is fully drained instead of after every file,
      // and only when something changed: saving rewrites every shard.
      if (this.changes !== changesAtStart) {
        this.plugin.setIndexingStatus("Saving brain index...");
        await this.saveIndex();
      }
    } finally {
      this.isProcessingQueue = false;
      this.plugin.setIndexingStatus(null);
    }
  }

  /**
   * Indexes a single file (Internal use by queue or rebuild).
   * Returns true if the file was embedded, false if skipped.
   */
  private async indexFile(file: TFile): Promise<boolean> {
    try {
      // Pattern-based eligibility: if excluded, remove any stale entries.
      if (!this.isPathIndexableByPatterns(file.path)) {
        this.removeEntriesForPath(file.path);
        return false;
      }

      // Crucial mtime check to prevent redundant re-indexing of unchanged files
      const existing = this.getEntriesForPath(file.path);
      if (existing.length > 0 && existing[0].mtime >= file.stat.mtime) {
        return false;
      }

      // Chunk-hash based reuse map (only effective after at least one hash-aware build)
      const existingEmbeddingByHash = new Map<string, Int8Array>();
      for (const e of existing) {
        if (!e.chunkHash) continue;
        const emb = typeof e.embedding === "string" ? decompressEmbeddingToInt8(e.embedding) : e.embedding;
        existingEmbeddingByHash.set(e.chunkHash, emb);
      }

      // See rebuildIndex: entries carry the mtime of the version that was read.
      const mtimeAtRead = file.stat.mtime;
      await this.plugin.embeddingService.resolveEmbeddingModelName();
      const isPdf = file.extension.toLowerCase() === "pdf";
      let content = "";
      if (isPdf) {
        const textExtractor = this.getTextExtractorApi();
        if (!textExtractor) {
          this.removeEntriesForPath(file.path);
          return false;
        }
        content = (await textExtractor.extractText(file)) || "";
        const maxChars = Math.max(10_000, this.plugin.settings.vaultIndexPdfMaxChars || 0);
        if (content.length > maxChars) content = content.slice(0, maxChars);
      } else {
        content = await this.plugin.app.vault.read(file);
      }
      if (!content.trim()) {
        this.removeEntriesForPath(file.path);
        return false;
      }

      const chunksWithOffsets = this.plugin.embeddingService.chunkTextWithOffsets(content);
      const validChunks = chunksWithOffsets.filter((c) => c.text.trim().length > 0);

      // Frontmatter summaries/tags only exist for Markdown notes.
      const fmData = isPdf ? null : this.extractFrontmatterSummary(content, file);
      const hasFmSummary = fmData !== null;

      if (validChunks.length > 0 || hasFmSummary) {
        const headings = isPdf ? [] : extractHeadings(content);
        const bilingualTags = fmData?.tagsOnly || "";
        const highlightsOnly = isPdf ? "" : this.highlightsOf(content);
        const hasHighlights = Boolean(highlightsOnly);

        const embeddingTexts = validChunks.map((c) => {
          const hp = headingPathAtOffset(headings, c.start);
          const docPrefix = getModelPrefixes(this.plugin.embeddingService.embeddingModelName()).doc;
          // Prepend bilingual tags to every chunk so the vector captures both languages.
          // Tags are brief (30–80 chars) and won't dilute the body content meaningfully.
          const tagLine = bilingualTags ? `Tags: ${bilingualTags}\n` : "";
          return `${docPrefix}${file.basename}${hp ? " > " + hp : ""}\n${tagLine}\n${c.text}`;
        });

        if (hasHighlights) {
          const docPrefix = getModelPrefixes(this.plugin.embeddingService.embeddingModelName()).doc;
          embeddingTexts.unshift(`${docPrefix}${file.basename}\nHighlights:\n${highlightsOnly}`);
        }

        if (hasFmSummary) embeddingTexts.unshift(fmData.fullText);

        const chunkHashes = embeddingTexts.map((t) => chunkHash(t));

        const resolvedEmbeddings: Array<Int8Array | null> = new Array<Int8Array | null>(
          embeddingTexts.length,
        ).fill(null);
        const toEmbedTexts: string[] = [];
        const toEmbedIndices: number[] = [];

        for (let i = 0; i < embeddingTexts.length; i++) {
          const hash = chunkHashes[i];
          const reused = existingEmbeddingByHash.get(hash);
          if (reused) {
            resolvedEmbeddings[i] = reused;
          } else {
            toEmbedIndices.push(i);
            toEmbedTexts.push(embeddingTexts[i]);
          }
        }

        if (toEmbedTexts.length > 0) {
          const embeddings = await this.plugin.embeddingService.getEmbeddings(toEmbedTexts);
          if (!embeddings || embeddings.length !== toEmbedTexts.length) {
            throw new Error(
              `API returned ${embeddings?.length || 0} embeddings for ${toEmbedTexts.length} chunks. Cancelling to prevent data loss.`,
            );
          }
          for (let i = 0; i < embeddings.length; i++) {
            const idx = toEmbedIndices[i];
            const emb = embeddings[i];
            if (emb && emb.length > 0) {
              resolvedEmbeddings[idx] = quantizeEmbeddingToInt8(emb);
            }
          }
        }

        const newEntries: IndexEntry[] = [];
        let cursor = 0;
        if (hasFmSummary) {
          const emb = resolvedEmbeddings[cursor];
          if (emb && emb.length > 0) {
            newEntries.push({
              path: file.path,
              chunkStart: 0,
              chunkEnd: 0,
              entryType: "summary",
              embedding: emb,
              mtime: mtimeAtRead,
              chunkHash: chunkHashes[cursor],
              summaryText: fmData.summaryOnly,
              tagsText: fmData.tagsOnly,
            });
          }
          cursor += 1;
        }

        if (hasHighlights) {
          const emb = resolvedEmbeddings[cursor];
          if (emb && emb.length > 0) {
            newEntries.push({
              path: file.path,
              chunkStart: 0,
              chunkEnd: 0,
              entryType: "highlights",
              embedding: emb,
              mtime: mtimeAtRead,
              chunkHash: chunkHashes[cursor],
              highlightsText: highlightsOnly ?? undefined,
            });
          }
          cursor += 1;
        }

        for (let j = 0; j < validChunks.length; j++) {
          const emb = resolvedEmbeddings[j + cursor];
          if (emb && emb.length > 0) {
            const hp = headingPathAtOffset(headings, validChunks[j].start);
            newEntries.push({
              path: file.path,
              chunkStart: validChunks[j].start,
              chunkEnd: validChunks[j].end,
              entryType: "content",
              embedding: emb,
              mtime: mtimeAtRead,
              chunkHash: chunkHashes[j + cursor],
              ...(hp ? { headingPath: hp } : {}),
              ...(bilingualTags ? { tagsText: bilingualTags } : {}),
            });
          }
        }
        this.removeEntriesForPath(file.path);
        this.addEntries(newEntries);
        return true;
      } else {
        this.removeEntriesForPath(file.path);
        return false;
      }
    } catch (e: unknown) {
      this.plugin.diagnosticService.report(
        "Vault Brain",
        `Auto-index failed for ${file.path}: ${errorToMessage(e)}`,
        "warning",
      );
      return false;
    }
  }
}
