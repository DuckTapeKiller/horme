import { TFile, Notice, normalizePath } from "obsidian";
import { minimatch } from "minimatch";
import HormePlugin from "../../main";
import { HormeErrorModal } from "../modals/HormeErrorModal";
import {
  compressEmbedding,
  cosineSimilarityFloatInt8,
  cosineSimilarityInt8,
  decompressEmbeddingToInt8,
  getModelPrefixes,
  quantizeEmbeddingToInt8,
} from "../utils/VectorUtils";
import type { AiProvider as TagProviderId } from "../types";
import { OllamaProvider } from "../providers/OllamaProvider";
import { LmStudioProvider } from "../providers/LmStudioProvider";
import type { AiProvider as AiProviderClient } from "../providers/AiProvider";
import { ClaudeProvider } from "../providers/ClaudeProvider";
import { GeminiProvider } from "../providers/GeminiProvider";
import { OpenAIProvider } from "../providers/OpenAIProvider";
import { GroqProvider } from "../providers/GroqProvider";
import { OpenRouterProvider } from "../providers/OpenRouterProvider";
import { MistralProvider } from "../providers/MistralProvider";
import {
  asArray,
  asNumberArray,
  errorToMessage,
  getNumberProp,
  getRecordProp,
  getStringProp,
} from "../utils/TypeGuards";

interface IndexEntry {
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

interface TagTranslationRunStats {
  primary: TagProviderId;
  fallback: TagProviderId;
  primaryIsCloud: boolean;
  allowCloudTagTranslation: boolean;
  cloudOkChunks: number;
  fallbackUsedChunks: number;
  totalFailures: number;
  fallbackWarningLogged: boolean;
  fallbackNoticeShown: boolean;
}

type VaultSearchScope = {
  files?: string[];
  folders?: string[];
};

type TextExtractorApi = {
  extractText: (file: TFile) => Promise<string>;
  canFileBeExtracted?: (filePath: string) => boolean;
  isInCache?: (file: TFile) => Promise<boolean>;
};

const STOP_WORDS = new Set([
  "ayudame",
  "encontrar",
  "podrias",
  "busca",
  "encuentra",
  "dime",
  "sobre",
  "hablame",
  "tienes",
  "algo",
  "articulo",
  "nota",
  "notas",
  "vault",
  "boveda",
  "mi",
  "mis",
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "these",
  "those",
  "about",
  "find",
  "help",
  "note",
  "search",
  "does",
  "what",
  "where",
  "when",
  "how",
  "why",
  "who",
  "which",
  "un",
  "una",
  "unos",
  "unas",
  "el",
  "la",
  "los",
  "las",
  "en",
  "con",
  "por",
  "para",
  "que",
  "del",
  "al",
  "was",
  "were",
  "been",
  "have",
  "has",
  "had",
  "pais",
  "paises",
  "estilos",
  "generos",
  "periodos",
  "estructuras",
]);

export class VaultIndexer {
  private plugin: HormePlugin;
  public index: IndexEntry[] = [];
  private pathIndex: Map<string, IndexEntry[]> = new Map();
  public indexedModel: string = "";
  public loadWasPartial: boolean = false;
  private isSaving: boolean = false;
  private pendingSave: boolean = false;
  private lastShardSaveTime: number = 0;
  private indexPath: string;
  // Cache of Spanish tag string → bilingual tag string.
  // Built during indexing to avoid redundant LLM calls for notes sharing the same tags.
  // Cleared when the plugin unloads (in-memory only — intentionally not persisted).
  private tagTranslationCache: Map<string, string> = new Map();
  private hasReportedEmptyTagTranslationModel = false;
  private tagTranslationRunStats: TagTranslationRunStats | null = null;

  /** O(1) lookup of entries by path */
  private getEntriesForPath(path: string): IndexEntry[] {
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

  private getCachePath(): string {
    const configDir = this.plugin.app.vault.configDir;
    return normalizePath(`${configDir}/plugins/${this.plugin.manifest.id}/Tag History/translations.json`);
  }

  async loadTagCache(): Promise<void> {
    const path = this.getCachePath();
    const adapter = this.plugin.app.vault.adapter;
    if (await adapter.exists(path)) {
      try {
        const data = await adapter.read(path);
        const parsed = JSON.parse(data) as Record<string, string>;
        this.tagTranslationCache = new Map(Object.entries(parsed));
      } catch (e) {
        console.error("Horme Brain: Failed to parse Tag History", e);
        this.tagTranslationCache = new Map();
      }
    } else {
      this.tagTranslationCache = new Map();
    }
  }

  async saveTagCache(): Promise<void> {
    const path = this.getCachePath();
    const adapter = this.plugin.app.vault.adapter;
    const folderPath = path.substring(0, path.lastIndexOf("/"));

    if (!(await adapter.exists(folderPath))) {
      await adapter.mkdir(folderPath);
    }

    const obj = Object.fromEntries(this.tagTranslationCache);
    await adapter.write(path, JSON.stringify(obj, null, 2));
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

    // Load persisted tag translations into RAM
    this.tagTranslationCache = new Map(); // Will be populated async via loadTagCache()
    // Explicitly resolve the plugin directory relative to the vault root
    const configDir = this.plugin.app.vault.configDir;
    this.indexPath = normalizePath(
      `${configDir}/plugins/${this.plugin.manifest.id}/Vault Index/vault-index.json`,
    );
    this.plugin.debugLog(`Horme Brain: Initializing index at ${this.indexPath}`);
    void this.loadIndex();

    // Wipe index if embedding model changes while plugin is running
    this.plugin.onSettingsChange(() => {
      const current = this.plugin.settings.ragEmbeddingModel;
      if (this.indexedModel && this.indexedModel !== current) {
        this.plugin.debugLog(
          `Horme Brain: Model changed to ${current}. Clearing in-memory index and shard files.`,
        );
        this.clearIndex();
        this.indexedModel = current;
        this.deleteAllShards().catch((e: unknown) => {
          this.plugin.diagnosticService.report(
            "Vault Brain",
            `Failed to delete stale shard files: ${errorToMessage(e)}`,
          );
        });
        new Notice("Vault Brain: Embedding model changed. Index cleared — please rebuild.");
      }
    });
  }

  private readonly SHARD_SIZE = 5000;

  private getShardPath(shardIndex: number): string {
    const configDir = this.plugin.app.vault.configDir;
    return normalizePath(
      `${configDir}/plugins/${this.plugin.manifest.id}/Vault Index/vault-index-shard-${String(shardIndex).padStart(3, "0")}.json`,
    );
  }

  private async loadIndex(): Promise<void> {
    try {
      await this.loadTagCache();
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
          const currentModel = this.plugin.settings.ragEmbeddingModel;
          if (this.indexedModel !== currentModel) {
            this.clearIndex();
            this.indexedModel = currentModel;
          }
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
    const currentModel = this.plugin.settings.ragEmbeddingModel;

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
      if (this.indexedModel !== currentModel) {
        this.plugin.debugLog(
          `Horme Brain: Embedding model changed (${this.indexedModel} → ${currentModel}). Wiping all shards.`,
        );
        this.clearIndex();
        this.indexedModel = currentModel;
        await this.deleteAllShards();
        return;
      }

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

          if (modelProp !== currentModel || shardProp !== shardIndex || totalProp !== expectedTotalShards) {
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

        const currentModel = this.plugin.settings.ragEmbeddingModel;
        const totalShards = Math.max(1, Math.ceil(this.index.length / this.SHARD_SIZE));

        // ── Phase 1: Write all shards to temporary files ──
        // If the process crashes here, only .tmp files are affected;
        // the previous valid shards remain untouched on disk.
        const tmpPaths: string[] = [];
        const finalPaths: string[] = [];

        for (let i = 0; i < totalShards; i++) {
          const shardEntries = this.index.slice(i * this.SHARD_SIZE, (i + 1) * this.SHARD_SIZE).map((e) => ({
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
      this.tagTranslationCache.clear();
      const cachePath = this.getCachePath();
      if (await adapter.exists(cachePath)) {
        await adapter.remove(cachePath);
      }
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

  /** Extracts all markdown headings with their character offsets */
  private extractHeadings(content: string): Array<{ level: number; text: string; offset: number }> {
    const headings: Array<{ level: number; text: string; offset: number }> = [];

    // Mask code blocks with spaces to preserve character offsets while hiding comments
    const maskedContent = content.replace(/```[\s\S]*?```/g, (match) => " ".repeat(match.length));

    const regex = /^(#{1,6})\s+(.+)$/gm;
    let match;
    while ((match = regex.exec(maskedContent)) !== null) {
      headings.push({ level: match[1].length, text: match[2].trim(), offset: match.index });
    }
    return headings;
  }

  /** Returns the heading hierarchy path at a given character offset */
  private getHeadingPathAtOffset(
    headings: Array<{ level: number; text: string; offset: number }>,
    offset: number,
  ): string {
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
    return stack.join(" > ");
  }

  /**
   * Splits a raw Obsidian tag into its path components and leaf value.
   *
   * Rule: the LAST slash-separated segment is always the leaf value.
   * All preceding segments are path/category components.
   * Underscores are converted to spaces in all segments.
   *
   * Examples:
   *   "#artistas_suizos"               → { path: [],                           leaf: "artistas suizos" }
   *   "#escritores/jorge_luis_borges"  → { path: ["escritores"],               leaf: "jorge luis borges" }
   *   "#arquitectura/estilos/eclect…"  → { path: ["arquitectura", "estilos"],  leaf: "eclecticismo" }
   *   "#arte/país/alemania"            → { path: ["arte", "país"],             leaf: "alemania" }
   */
  private splitTagHierarchy(raw: string): { path: string[]; leaf: string } {
    const stripped = raw.replace(/^#+/, "").trim();
    const segments = stripped
      .split("/")
      .map((s) => s.replace(/_/g, " ").trim())
      .filter((s) => s.length > 0);

    if (segments.length === 0) return { path: [], leaf: "" };
    if (segments.length === 1) return { path: [], leaf: segments[0] };

    return {
      path: segments.slice(0, segments.length - 1),
      leaf: segments[segments.length - 1],
    };
  }

  /**
   * Generic Spanish navigation words that appear as intermediate nodes
   * in the tag hierarchy. These are useless as keyword search terms because
   * they are present on every note in their domain category.
   * When a tag like #arquitectura/país is used as a standalone tag (making
   * "país" the leaf value), it contributes nothing to discriminating search.
   */
  private static readonly GENERIC_TAG_NODES = new Set([
    "país",
    "países",
    "estilos",
    "géneros",
    "períodos",
    "estructuras",
    "región",
    "regiones",
    "tipo",
    "tipos",
    "categoría",
    "categorías",
  ]);

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
  private collectShadowTags(content: string, file: TFile): string[] {
    const rawTags: string[] = [];
    const add = (value: string) => {
      if (value && value.trim()) rawTags.push(value.trim());
    };

    const cache = this.plugin.app.metadataCache.getFileCache(file);
    if (cache?.tags) {
      for (const t of cache.tags) add(t.tag);
    }

    const frontmatter: Record<string, unknown> | undefined = cache?.frontmatter;
    if (frontmatter) {
      for (const tag of this.extractTagValues(frontmatter.tags)) add(tag);
      for (const tag of this.extractTagValues(frontmatter.tag)) add(tag);
    }

    const inlineTagRegex = /(^|\s)#([^\s#[\]{}()<>"',.!?;]+)/gm;
    let match: RegExpExecArray | null;
    while ((match = inlineTagRegex.exec(content)) !== null) {
      add(match[2]);
    }

    const uniqueTerms = new Set<string>();

    for (const raw of rawTags) {
      const { path, leaf } = this.splitTagHierarchy(raw);

      if (leaf && !VaultIndexer.GENERIC_TAG_NODES.has(leaf.toLowerCase())) {
        uniqueTerms.add(leaf);
      }

      for (const p of path) {
        if (p && !VaultIndexer.GENERIC_TAG_NODES.has(p.toLowerCase())) {
          uniqueTerms.add(p);
        }
      }
    }

    return Array.from(uniqueTerms).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }

  private extractHighlightsOnlyText(content: string): string | null {
    if (!this.plugin.settings.indexHighlightsEnabled) return null;

    // Ignore frontmatter and code to avoid indexing accidental highlight markers.
    let text = content.replace(/^---[\s\S]*?---\s*/m, "");
    text = text.replace(/```[\s\S]*?```/g, "\n").replace(/~~~[\s\S]*?~~~/g, "\n");
    text = text.replace(/`[^`\n]*`/g, " ");

    const out: string[] = [];
    const seen = new Set<string>();

    // Obsidian highlight syntax: ==highlight==
    const mdRe = /==([^=\n].*?[^=\n])==/g;
    let mdMatch: RegExpExecArray | null;
    while ((mdMatch = mdRe.exec(text)) !== null) {
      const v = mdMatch[1].trim();
      if (!v) continue;
      const key = v.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(v);
    }

    // Highlightr-style HTML marks: <mark ...>highlight</mark>
    const markRe = /<mark\b[^>]*>([\s\S]*?)<\/mark>/gi;
    let markMatch: RegExpExecArray | null;
    while ((markMatch = markRe.exec(text)) !== null) {
      const raw = markMatch[1].replace(/<[^>]+>/g, "").trim();
      if (!raw) continue;
      const key = raw.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(raw);
    }

    if (out.length === 0) return null;

    const maxCount = Math.max(0, this.plugin.settings.maxHighlightsPerNote || 0);
    const maxChars = Math.max(0, this.plugin.settings.maxHighlightCharsPerNote || 0);

    const capped = maxCount > 0 ? out.slice(0, maxCount) : [];
    if (capped.length === 0) return null;

    let joined = capped.join("\n");
    if (maxChars > 0 && joined.length > maxChars) {
      joined = joined.slice(0, maxChars);
    }

    return joined.trim() ? joined.trim() : null;
  }

  private async preTranslateTags(files: TFile[]) {
    if (!this.plugin.settings.tagShadowingEnabled) return;

    this.plugin.setIndexingStatus("Scanning for new tags...");
    const uniqueTagInputs = new Set<string>();

    for (const file of files) {
      const content = await this.plugin.app.vault.cachedRead(file);
      const tags = this.collectShadowTags(content, file);

      for (const tag of tags) {
        if (!this.tagTranslationCache.has(tag)) {
          uniqueTagInputs.add(tag);
        }
      }
    }

    if (uniqueTagInputs.size > 0) {
      this.plugin.setIndexingStatus(`Pre-translating ${uniqueTagInputs.size} unique tags...`);
      const settings = this.plugin.settings;
      const translationChain = this.getTagTranslationChain(500);
      if (translationChain.length > 0) {
        this.tagTranslationRunStats = {
          primary: settings.tagTranslationProvider,
          fallback: settings.tagTranslationFallbackProvider,
          primaryIsCloud: this.isCloudProvider(settings.tagTranslationProvider),
          allowCloudTagTranslation: settings.allowCloudTagTranslation,
          cloudOkChunks: 0,
          fallbackUsedChunks: 0,
          totalFailures: 0,
          fallbackWarningLogged: false,
          fallbackNoticeShown: false,
        };

        const termsArray = Array.from(uniqueTagInputs);
        const CHUNK_SIZE = 8; // Safely throttled to eliminate model tracking fatigue
        let lastSaveTime = Date.now();

        for (let i = 0; i < termsArray.length; i += CHUNK_SIZE) {
          const chunk = termsArray.slice(i, i + CHUNK_SIZE);
          const chunkList = chunk.map((term, index) => `t${index} -> ${term}`).join("\n");

          try {
            const systemPrompt = `You are a mechanical, automated translation tool mapping Spanish items to ${settings.tagShadowingLanguage}.
Translate ONLY the values on the right side of the -> delimiter.

CRITICAL PROCESSING RULES:
1. NO REFUSALS: Act strictly as a data processor. Never censor, skip, or refuse explicit, sensitive, or controversial terms (e.g., "prostitución", "sexo", "zoofilia"). Translate them directly.
2. ANCHOR PRESERVATION: You MUST retain the exact token anchor identifier (e.g., t0 ->, t1 ->) on the left side of the line. Do not alter the index character or replace it with raw numbers.
3. DOMAIN ACCURACY:
   - "letras" -> letters
   - "gentilicios" -> demonyms
   - "concept" -> concept
4. LINGUISTIC TERMS: If a term has no translation (e.g., "dequeísmo", "queísmo", "laísmo"), return the original Spanish word exactly. Never map to religious concepts like "deism".
5. ZERO CHATTER: Output ONLY the translated list lines. No introductions, no notes, no markdown block wrappers.

FORMAT EXAMPLE:
t0 -> Translation
t1 -> Translation`;

            let result: string | null = null;
            let lastErr: unknown = null;
            let cloudPrimaryErr: unknown = null;
            let winningCandidateId: TagProviderId | null = null;

            for (const candidate of translationChain) {
              try {
                result = await candidate.provider.generate(
                  `Translate these anchored targets exactly:\n${chunkList}`,
                  systemPrompt,
                  candidate.model,
                );
                winningCandidateId = candidate.id;
                break;
              } catch (e: unknown) {
                lastErr = e;
                if (
                  this.tagTranslationRunStats?.primaryIsCloud &&
                  this.tagTranslationRunStats.allowCloudTagTranslation &&
                  candidate.id === this.tagTranslationRunStats.primary
                ) {
                  cloudPrimaryErr = e;
                }
              }
            }

            if (result === null) {
              throw lastErr instanceof Error ? lastErr : new Error(errorToMessage(lastErr));
            }

            // Track which provider actually succeeded per chunk (cloud vs fallback).
            if (
              this.tagTranslationRunStats?.primaryIsCloud &&
              this.tagTranslationRunStats.allowCloudTagTranslation
            ) {
              const primaryId = this.tagTranslationRunStats.primary;
              const fallbackId = this.tagTranslationRunStats.fallback;
              if (winningCandidateId === primaryId) {
                this.tagTranslationRunStats.cloudOkChunks++;
              } else if (winningCandidateId === fallbackId && cloudPrimaryErr !== null) {
                this.tagTranslationRunStats.fallbackUsedChunks++;

                const cloudName = primaryId.charAt(0).toUpperCase() + primaryId.slice(1);
                const fallbackName = fallbackId.charAt(0).toUpperCase() + fallbackId.slice(1);
                const errMsg = errorToMessage(cloudPrimaryErr);

                // Log once per indexing run (avoid flooding diagnostics).
                if (!this.tagTranslationRunStats.fallbackWarningLogged) {
                  this.tagTranslationRunStats.fallbackWarningLogged = true;
                  this.plugin.diagnosticService.report(
                    "Tag Translation",
                    `Tag translation: cloud ${cloudName} failed → using local fallback ${fallbackName} (error: ${errMsg})`,
                    "warning",
                  );
                }

                // Notice once per indexing run (avoid spamming toasts).
                if (!this.tagTranslationRunStats.fallbackNoticeShown) {
                  this.tagTranslationRunStats.fallbackNoticeShown = true;
                  new Notice(
                    `Vault Brain: Cloud tag translation failed — using local fallback ${fallbackName} for this run.`,
                    8000,
                  );
                }
              }
            }

            // 1. Parse lines with space-resilient index token identification
            const lines = result
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => /t\s*\d+\s*(?:->|◈|:|=>|=)/.test(line));

            // 2. Build the lookup map matching index values back to terms safely
            const translationMap = new Map<string, string>();
            lines.forEach((line) => {
              const match = line.match(/t\s*(\d+)\s*(?:->|◈|:|=>|=)\s*(.*)/);
              if (match) {
                const idx = parseInt(match[1], 10);
                if (idx >= 0 && idx < chunk.length) {
                  let trans = match[2].trim();
                  // Strip decorative markdown wrappers from boundary lines
                  trans = trans.replace(/^[\s_*`"'_[\]()\]]+/, "").replace(/[\s_*`"'_[\]()\]]+$/, "");
                  trans = trans.replace(/[.,;]+$/, "");

                  if (trans) {
                    translationMap.set(chunk[idx].toLowerCase(), trans);
                  }
                }
              }
            });

            // 3. Map back to the chunk array using normalized lookups
            chunk.forEach((term) => {
              const translation = translationMap.get(term.toLowerCase()) || term;
              const combined = `${term}, ${translation}`;
              this.tagTranslationCache.set(term, combined);
            });
          } catch (e: unknown) {
            if (this.tagTranslationRunStats) this.tagTranslationRunStats.totalFailures++;
            this.plugin.diagnosticService.report(
              "Vault Brain",
              `Tag translation chunk failed: ${errorToMessage(e)}`,
              "warning",
            );
            chunk.forEach((term) => {
              this.tagTranslationCache.set(term, term);
            });
          }

          // TIME-BASED CHECKPOINT: Guarantees at least 15 seconds between disk writes.
          // This gives aggressive sync engines (iCloud/Dropbox) ample time to release
          // file locks, entirely preventing file duplication on fast translation runs.
          const now = Date.now();
          if (now - lastSaveTime > 15000) {
            await this.saveTagCache();
            lastSaveTime = now;
          }

          // Mandatory 400ms pacing delay to clear context queue on local server instances
          await new Promise((resolve) => window.setTimeout(resolve, 400));
        }

        // 🟢 Final guaranteed storage commit after all chunks finish
        await this.saveTagCache();
      }
    }
  }

  private translateTagsBilingually(spanishTags: string): string {
    if (!this.plugin.settings.tagShadowingEnabled || !spanishTags.trim()) return spanishTags;
    const cached = this.tagTranslationCache.get(spanishTags);
    return cached !== undefined ? cached : spanishTags;
  }

  /**
   * Samples the vault to collect representative tag path components and
   * leaf values, runs them through the translation model, and returns a
   * structured result for display in the settings panel.
   *
   * This is a READ-ONLY diagnostic operation. It does not modify the index,
   * the translation cache, or any settings.
   *
   * Returns an array of result rows, each containing:
   * - type: "path" (generic category label) or "leaf" (specific value)
   * - original: the Spanish input string
   * - translated: what the model returned, or null on failure
   * - warning: a human-readable warning if the output looks malformed
   */
  async testTagTranslation(): Promise<
    {
      type: "path" | "leaf";
      original: string;
      translated: string | null;
      warning: string | null;
    }[]
  > {
    const files = this.plugin.app.vault.getMarkdownFiles();

    // Scan vault in-memory cache to get real tags
    const uniquePaths = new Set<string>();
    const uniqueLeaves = new Set<string>();

    for (const file of files) {
      const cache = this.plugin.app.metadataCache.getFileCache(file);
      const rawTags: string[] = [];
      const add = (value: string) => {
        if (value && value.trim()) rawTags.push(value.trim());
      };

      if (cache?.tags) {
        for (const t of cache.tags) add(t.tag);
      }
      const frontmatter: Record<string, unknown> | undefined = cache?.frontmatter;
      if (frontmatter) {
        for (const tag of this.extractTagValues(frontmatter.tags)) add(tag);
        for (const tag of this.extractTagValues(frontmatter.tag)) add(tag);
      }

      for (const raw of rawTags) {
        const { path, leaf } = this.splitTagHierarchy(raw);
        if (leaf && !VaultIndexer.GENERIC_TAG_NODES.has(leaf.toLowerCase())) {
          uniqueLeaves.add(leaf);
        }
        for (const p of path) {
          if (p && !VaultIndexer.GENERIC_TAG_NODES.has(p.toLowerCase())) {
            uniquePaths.add(p);
          }
        }
      }
    }

    const pathSample = Array.from(uniquePaths).slice(0, 20);
    const leafSample = Array.from(uniqueLeaves).slice(0, 15);

    const results: {
      type: "path" | "leaf";
      original: string;
      translated: string | null;
      warning: string | null;
    }[] = [];

    if (pathSample.length === 0 && leafSample.length === 0) {
      return results;
    }

    const settings = this.plugin.settings;
    const translationChain = this.getTagTranslationChain(200);
    if (translationChain.length === 0) {
      throw new Error(
        "No Tag Translation Provider/Model is configured. Enable tag shadowing and configure a provider (cloud or local) plus a usable model.",
      );
    }

    const testRunStats = {
      primary: settings.tagTranslationProvider,
      fallback: settings.tagTranslationFallbackProvider,
      primaryIsCloud: this.isCloudProvider(settings.tagTranslationProvider),
      allowCloudTagTranslation: settings.allowCloudTagTranslation,
      cloudOkChunks: 0,
      fallbackUsedChunks: 0,
      totalFailures: 0,
      fallbackWarningLogged: false,
      fallbackNoticeShown: false,
    };

    const runAnchoredTest = async (sample: string[], contextRule: string, type: "path" | "leaf") => {
      const chunkList = sample.map((term, index) => `t${index} -> ${term}`).join("\n");
      const systemPrompt = `You are a mechanical translation tool mapping Spanish to ${settings.tagShadowingLanguage}.
Translate ONLY the values on the right side of the -> delimiter.

CRITICAL RULES:
1. ANCHOR PRESERVATION: You MUST retain the exact token anchor identifier (e.g., t0 ->, t1 ->) on the left side of the line.
2. ZERO CHATTER: Output ONLY the translated list lines. No explanations.
3. ${contextRule}

FORMAT EXAMPLE:
t0 -> Translation
t1 -> Translation`;

      try {
        let result: string | null = null;
        let lastErr: unknown = null;
        let cloudPrimaryErr: unknown = null;
        let winningCandidateId: TagProviderId | null = null;
        for (const candidate of translationChain) {
          try {
            result = await candidate.provider.generate(
              `Translate these anchored targets exactly:\n${chunkList}`,
              systemPrompt,
              candidate.model,
            );
            winningCandidateId = candidate.id;
            break;
          } catch (e: unknown) {
            lastErr = e;
            if (
              testRunStats.primaryIsCloud &&
              testRunStats.allowCloudTagTranslation &&
              candidate.id === testRunStats.primary
            ) {
              cloudPrimaryErr = e;
            }
          }
        }

        if (result === null) {
          throw lastErr instanceof Error ? lastErr : new Error(errorToMessage(lastErr));
        }

        if (testRunStats.primaryIsCloud && testRunStats.allowCloudTagTranslation) {
          if (winningCandidateId === testRunStats.primary) {
            testRunStats.cloudOkChunks++;
          } else if (winningCandidateId === testRunStats.fallback && cloudPrimaryErr !== null) {
            testRunStats.fallbackUsedChunks++;

            const cloudName = testRunStats.primary.charAt(0).toUpperCase() + testRunStats.primary.slice(1);
            const fallbackName =
              testRunStats.fallback.charAt(0).toUpperCase() + testRunStats.fallback.slice(1);
            const errMsg = errorToMessage(cloudPrimaryErr);

            if (!testRunStats.fallbackWarningLogged) {
              testRunStats.fallbackWarningLogged = true;
              this.plugin.diagnosticService.report(
                "Tag Translation",
                `Tag translation (test): cloud ${cloudName} failed → using local fallback ${fallbackName} (error: ${errMsg})`,
                "warning",
              );
            }

            if (!testRunStats.fallbackNoticeShown) {
              testRunStats.fallbackNoticeShown = true;
              new Notice(
                `Vault Brain: Cloud tag translation test failed — using local fallback ${fallbackName}.`,
                8000,
              );
            }
          }
        }

        const lines = result
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => /t\s*\d+\s*(?:->|◈|:|=>|=)/.test(line));

        const translationMap = new Map<number, string>();
        lines.forEach((line) => {
          const match = line.match(/t\s*(\d+)\s*(?:->|◈|:|=>|=)\s*(.*)/);
          if (match) {
            const idx = parseInt(match[1], 10);
            let trans = match[2].trim();
            trans = trans.replace(/^[\s_*`"'[\]()\]]+/, "").replace(/[\s_*`"'[\]()\]]+$/, "");
            trans = trans.replace(/[.,;]+$/, "");
            if (trans) {
              translationMap.set(idx, trans);
            }
          }
        });

        sample.forEach((original, i) => {
          const translated = translationMap.get(i) || null;
          results.push({
            type,
            original,
            translated,
            warning: translated ? null : "Model omitted this anchor or failed to parse.",
          });
        });
      } catch (e: unknown) {
        testRunStats.totalFailures++;
        sample.forEach((original) => {
          results.push({ type, original, translated: null, warning: errorToMessage(e) });
        });
      }
    };

    if (pathSample.length > 0) {
      await runAnchoredTest(pathSample, "Translate generic category labels.", "path");
    }
    if (leafSample.length > 0) {
      await runAnchoredTest(leafSample, "Translate common nouns. Preserve proper nouns exactly.", "leaf");
    }

    if (testRunStats.primaryIsCloud && testRunStats.allowCloudTagTranslation) {
      this.plugin.diagnosticService.report(
        "Tag Translation",
        `Tag translation (test): cloud ok ${testRunStats.cloudOkChunks} chunks, fallback used ${testRunStats.fallbackUsedChunks} chunks, total failures ${testRunStats.totalFailures}.`,
        "info",
      );
    }

    return results;
  }

  private isCloudProvider(provider: TagProviderId): boolean {
    return provider !== "ollama" && provider !== "lmstudio";
  }

  private getTagTranslationModelFor(provider: TagProviderId): string {
    const s = this.plugin.settings;

    // Local: explicit translation model is preferred, but we can fall back to the configured local chat model.
    if (provider === "lmstudio")
      return (s.tagTranslationModel || "").trim() || (s.lmStudioModel || "").trim();
    if (provider === "ollama") return (s.tagTranslationModel || "").trim() || (s.defaultModel || "").trim();

    // Cloud: reuse the provider's configured model setting.
    if (provider === "claude") return (s.claudeModel || "").trim();
    if (provider === "gemini") return (s.geminiModel || "").trim();
    if (provider === "openai") return (s.openaiModel || "").trim();
    if (provider === "groq") return (s.groqModel || "").trim();
    if (provider === "openrouter") return (s.openRouterModel || "").trim();
    if (provider === "mistral") return (s.mistralModel || "").trim();

    return "";
  }

  private createProvider(provider: TagProviderId, maxTokens: number): AiProviderClient {
    const s = this.plugin.settings;
    const apiKey = this.plugin.getApiKeyForProvider(provider);

    switch (provider) {
      case "claude":
        return new ClaudeProvider(apiKey, s.temperature, maxTokens);
      case "gemini":
        return new GeminiProvider(apiKey, s.temperature, maxTokens);
      case "openai":
        return new OpenAIProvider(apiKey, s.temperature, maxTokens);
      case "groq":
        return new GroqProvider(apiKey, s.temperature, maxTokens);
      case "openrouter":
        return new OpenRouterProvider(apiKey, s.temperature, maxTokens);
      case "mistral":
        return new MistralProvider(apiKey, s.temperature, maxTokens);
      case "lmstudio":
        return new LmStudioProvider(s.lmStudioUrl, s.temperature, maxTokens);
      default:
        return new OllamaProvider(s.ollamaBaseUrl, s.temperature, maxTokens);
    }
  }

  private getTagTranslationChain(maxTokens: number): Array<{
    id: TagProviderId;
    provider: AiProviderClient;
    model: string;
  }> {
    const s = this.plugin.settings;
    const primary = s.tagTranslationProvider;
    const fallback = s.tagTranslationFallbackProvider;

    const chainIds: TagProviderId[] = [];
    if (!this.isCloudProvider(primary) || s.allowCloudTagTranslation) {
      chainIds.push(primary);
    }
    if (this.isCloudProvider(primary)) {
      chainIds.push(fallback);
    }

    const unique = Array.from(new Set(chainIds));
    const out: Array<{ id: TagProviderId; provider: AiProviderClient; model: string }> = [];

    for (const id of unique) {
      const model = this.getTagTranslationModelFor(id);
      if (!model) continue;
      out.push({ id, provider: this.createProvider(id, maxTokens), model });
    }

    return out;
  }

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
          summaryOnly = (frontmatter[key] as string).trim();
          break;
        }
      }
    }

    const tags = this.collectShadowTags(content, file);
    let tagsOnly = "";

    if (tags.length > 0) {
      tagsOnly = tags.map((t) => this.translateTagsBilingually(t)).join(", ");
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
      fullText: `${getModelPrefixes(this.plugin.settings.ragEmbeddingModel).doc}${parts.join("\n")}`,
      summaryOnly,
      tagsOnly,
    };
  }

  private parseGlobCsv(raw: string): string[] {
    return raw
      .split(/[,\n]/g)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  private getTextExtractorApi(): TextExtractorApi | undefined {
    // Optional dependency: community plugin "Text Extractor" (id: "text-extractor").
    // `app.plugins` is not part of Obsidian's public typings, so describe just the
    // shape we read instead of reaching through `any`.
    const internalApp = this.plugin.app as unknown as {
      plugins?: { plugins?: Record<string, { api?: TextExtractorApi } | undefined> };
    };
    return internalApp.plugins?.plugins?.["text-extractor"]?.api;
  }

  private isPathIndexableByPatterns(path: string): boolean {
    const include = this.parseGlobCsv(this.plugin.settings.vaultIndexIncludePatterns || "");
    const exclude = this.parseGlobCsv(this.plugin.settings.vaultIndexExcludePatterns || "");

    const opts = { dot: true };
    if (exclude.some((p) => minimatch(path, p, opts))) return false;
    if (include.length === 0) return true;
    return include.some((p) => minimatch(path, p, opts));
  }

  private filterFilesForIndexing(files: TFile[]): TFile[] {
    // Patterns apply to vault-relative paths, e.g. "Music/Note.md"
    return files.filter((f) => this.isPathIndexableByPatterns(f.path));
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

    this.tagTranslationCache.clear();
    this.lastShardSaveTime = 0;
    this.tagTranslationRunStats = null;

    try {
      this.plugin.setIndexingStatus("Initializing Index Rebuild...");

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

      const textExtractor = this.getTextExtractorApi();
      const pdfIndexRequested = Boolean(this.plugin.settings.vaultIndexIndexPdf);
      const pdfIndexEnabled = pdfIndexRequested && Boolean(textExtractor);

      if (pdfIndexRequested && !textExtractor) {
        this.plugin.diagnosticService.report(
          "Vault Brain",
          'PDF indexing is enabled, but the companion plugin "Text Extractor" (id: text-extractor) is not available. PDFs will be skipped.',
          "warning",
        );
      }

      const markdownFiles = this.plugin.app.vault.getMarkdownFiles();
      const pdfFiles = pdfIndexEnabled
        ? this.plugin.app.vault
            .getFiles()
            .filter((f) => f.extension.toLowerCase() === "pdf")
            .filter((f) =>
              textExtractor?.canFileBeExtracted ? textExtractor.canFileBeExtracted(f.path) : true,
            )
        : [];

      const allFiles = [...markdownFiles, ...pdfFiles];
      const files = this.filterFilesForIndexing(allFiles);
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
      await this.preTranslateTags(files.filter((f) => f.extension.toLowerCase() === "md"));

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
            const headings = isPdf ? [] : this.extractHeadings(content);
            const bilingualTags = fmData?.tagsOnly || "";
            const highlightsOnly = isPdf ? "" : this.extractHighlightsOnlyText(content);
            const hasHighlights = Boolean(highlightsOnly);

            // Build embedding texts with search_document prefix and heading context
            const embeddingTexts = validChunks.map((c) => {
              const hp = this.getHeadingPathAtOffset(headings, c.start);
              const docPrefix = getModelPrefixes(this.plugin.settings.ragEmbeddingModel).doc;
              // Prepend bilingual tags to every chunk so the vector captures both languages.
              // Tags are brief (30–80 chars) and won't dilute the body content meaningfully.
              const tagLine = bilingualTags ? `Tags: ${bilingualTags}\n` : "";
              return `${docPrefix}${file.basename}${hp ? " > " + hp : ""}\n${tagLine}\n${c.text}`;
            });

            // Add a dedicated highlights-only embedding per note (note-level entry).
            if (hasHighlights) {
              const docPrefix = getModelPrefixes(this.plugin.settings.ragEmbeddingModel).doc;
              embeddingTexts.unshift(`${docPrefix}${file.basename}\nHighlights:\n${highlightsOnly}`);
            }

            // Add a dedicated frontmatter summary embedding (offset 0,0 = signals summary entry)
            if (hasFmSummary) embeddingTexts.unshift(fmData.fullText);

            const chunkHashes = embeddingTexts.map((t) => VaultIndexer.chunkHash(t));

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
                  mtime: file.stat.mtime,
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
                  mtime: file.stat.mtime,
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
                const hp = this.getHeadingPathAtOffset(headings, validChunks[j].start);
                newEntries.push({
                  path: file.path,
                  chunkStart: validChunks[j].start,
                  chunkEnd: validChunks[j].end,
                  entryType: "content",
                  embedding: emb,
                  mtime: file.stat.mtime,
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
              `Indexing stopped after ${consecutiveErrors} consecutive failures. This usually means Ollama is unreachable or the embedding model is not loaded. Check that Ollama is running and that the model "${this.plugin.settings.ragEmbeddingModel}" is available.`,
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

      // Log translation results to diagnostics panel for post-rebuild audit
      if (this.tagTranslationCache.size > 0) {
        const cacheEntries = Array.from(this.tagTranslationCache.entries())
          .filter(([, v]) => v && v !== "") // skip fallback (untranslated) entries
          .slice(0, 30); // cap log length

        if (cacheEntries.length > 0) {
          const logLines = cacheEntries.map(([k, v]) => `  ${k} → ${v}`).join("\n");
          this.plugin.diagnosticService.report(
            "Tag Translation",
            `Translation results (${cacheEntries.length} unique inputs):\n${logLines}`,
            "info",
          );
        }
      }

      // Summarize whether tag translation actually used cloud vs fallback for this run.
      // Captured into a local (with its declared type) because TS narrows the field to
      // `null` from the reset at the top of rebuildIndex — it can't see that the
      // pre-translation step above repopulates it via a called helper.
      const runStats = this.tagTranslationRunStats as TagTranslationRunStats | null;
      if (runStats?.primaryIsCloud && runStats.allowCloudTagTranslation) {
        this.plugin.diagnosticService.report(
          "Tag Translation",
          `Tag translation: cloud ok ${runStats.cloudOkChunks} chunks, fallback used ${runStats.fallbackUsedChunks} chunks, total failures ${runStats.totalFailures}.`,
          "info",
        );
      }

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
    const canIndex = this.plugin.isLocalProviderActive() || this.plugin.settings.allowCloudRAG;
    if (!canIndex || !this.plugin.settings.vaultBrainEnabled) {
      return;
    }
    // Incremental indexing is only allowed after at least one successful full build.
    if (!(await this.hasBuiltIndex())) {
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

      let totalQueued = this.indexingQueue.length;
      let processed = 0;

      // Ensure queued files have tags pre-translated to avoid mid-queue VRAM swaps
      if (totalQueued > 0) {
        await this.preTranslateTags([...this.indexingQueue]);
      }

      while (this.indexingQueue.length > 0) {
        // Re-check on every iteration — provider may have changed since enqueue
        const canStillIndex = this.plugin.isLocalProviderActive() || this.plugin.settings.allowCloudRAG;
        if (!canStillIndex || !this.plugin.settings.vaultBrainEnabled) {
          this.plugin.debugLog("Horme Brain: Provider changed during queue processing. Clearing queue.");
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

      // Save once when the queue is fully drained instead of after every file.
      // This eliminates repeated synchronous JSON.stringify calls that block typing.
      if (processed > 0) {
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
        const headings = isPdf ? [] : this.extractHeadings(content);
        const bilingualTags = fmData?.tagsOnly || "";
        const highlightsOnly = isPdf ? "" : this.extractHighlightsOnlyText(content);
        const hasHighlights = Boolean(highlightsOnly);

        const embeddingTexts = validChunks.map((c) => {
          const hp = this.getHeadingPathAtOffset(headings, c.start);
          const docPrefix = getModelPrefixes(this.plugin.settings.ragEmbeddingModel).doc;
          // Prepend bilingual tags to every chunk so the vector captures both languages.
          // Tags are brief (30–80 chars) and won't dilute the body content meaningfully.
          const tagLine = bilingualTags ? `Tags: ${bilingualTags}\n` : "";
          return `${docPrefix}${file.basename}${hp ? " > " + hp : ""}\n${tagLine}\n${c.text}`;
        });

        if (hasHighlights) {
          const docPrefix = getModelPrefixes(this.plugin.settings.ragEmbeddingModel).doc;
          embeddingTexts.unshift(`${docPrefix}${file.basename}\nHighlights:\n${highlightsOnly}`);
        }

        if (hasFmSummary) embeddingTexts.unshift(fmData.fullText);

        const chunkHashes = embeddingTexts.map((t) => VaultIndexer.chunkHash(t));

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
              mtime: file.stat.mtime,
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
              mtime: file.stat.mtime,
              chunkHash: chunkHashes[cursor],
              highlightsText: highlightsOnly ?? undefined,
            });
          }
          cursor += 1;
        }

        for (let j = 0; j < validChunks.length; j++) {
          const emb = resolvedEmbeddings[j + cursor];
          if (emb && emb.length > 0) {
            const hp = this.getHeadingPathAtOffset(headings, validChunks[j].start);
            newEntries.push({
              path: file.path,
              chunkStart: validChunks[j].start,
              chunkEnd: validChunks[j].end,
              entryType: "content",
              embedding: emb,
              mtime: file.stat.mtime,
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

  private static normalizeTextForSearch(text: string): string {
    return text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  }

  /**
   * Stable, low-collision content hash for chunk-level incremental indexing.
   * Uses two parallel 32-bit FNV-1a accumulators (64-bit effective key) so we
   * can safely reuse embeddings across small edits without relying on BigInt.
   */
  private static chunkHash(text: string): string {
    const bytes = new TextEncoder().encode(text);
    let h1 = 0x811c9dc5;
    let h2 = (0x811c9dc5 ^ 0x9e3779b9) >>> 0;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      h1 ^= b;
      h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 ^= b;
      h2 = Math.imul(h2, 0x01000193) >>> 0;
      // Cross-mix to reduce correlated collisions when only seed differs
      h2 ^= (h1 + ((h1 << 7) | (h1 >>> 25))) >>> 0;
    }
    return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
  }

  private getSearchEntryKey(entry: IndexEntry): string {
    const type = entry.entryType ?? "unknown";
    const heading = entry.headingPath ?? "";
    return `${entry.path}::${type}::${entry.chunkStart}::${entry.chunkEnd}::${heading}`;
  }

  private isHighlightEntry(entry: IndexEntry): boolean {
    return (
      entry.entryType === "highlights" ||
      (entry.chunkStart === 0 && entry.chunkEnd === 0 && !!entry.highlightsText)
    );
  }

  private computeMetadataBonus(entry: IndexEntry, searchTerms: string[], quotedTerms: string[]): number {
    // Metadata keyword boosting: Exact quotes (Major) + Regular terms (Minor) (Accent-insensitive!)
    let metadataBonus = 0;
    const lowerPath = VaultIndexer.normalizeTextForSearch(entry.path);
    const lowerSummary = VaultIndexer.normalizeTextForSearch(entry.summaryText || "");
    const lowerTags = VaultIndexer.normalizeTextForSearch(entry.tagsText || "");
    const lowerHighlights = VaultIndexer.normalizeTextForSearch(entry.highlightsText || "");
    const lowerHeading = VaultIndexer.normalizeTextForSearch(entry.headingPath || "");

    // 1. Quoted terms get a massive priority boost
    for (const term of quotedTerms) {
      if (
        lowerPath.includes(term) ||
        lowerSummary.includes(term) ||
        lowerTags.includes(term) ||
        lowerHighlights.includes(term) ||
        lowerHeading.includes(term)
      ) {
        metadataBonus += 0.15;
      }
    }

    // 2. Regular keyword boosting, skipping stop-words
    for (const term of searchTerms) {
      if (STOP_WORDS.has(term)) continue;
      if (lowerPath.includes(term)) metadataBonus += 0.05;
      if (lowerSummary.includes(term)) metadataBonus += 0.04;
      if (lowerTags.includes(term)) metadataBonus += 0.03;
      if (lowerHighlights.includes(term)) metadataBonus += 0.04;
      if (lowerHeading.includes(term)) metadataBonus += 0.04;
    }

    // Cap the metadata bonus so it doesn't exponentially drown out semantic vector scores
    return Math.min(metadataBonus, this.plugin.settings.searchMetadataCap);
  }

  private computeContentBonusFromChunkText(
    chunkText: string,
    searchTerms: string[],
    quotedTerms: string[],
  ): number {
    let contentBonus = 0;
    const normalizedChunkText = VaultIndexer.normalizeTextForSearch(chunkText);

    for (const term of searchTerms) {
      if (STOP_WORDS.has(term)) continue;
      if (normalizedChunkText.includes(term)) {
        contentBonus += 0.05;
      }
    }
    for (const term of quotedTerms) {
      if (normalizedChunkText.includes(term)) contentBonus += 0.15;
    }
    return contentBonus;
  }

  private filterEntriesByScope(entries: IndexEntry[], scope?: VaultSearchScope): IndexEntry[] {
    if (!scope) return entries;
    const files = (scope.files ?? []).map((p) => normalizePath(p)).filter((p) => p.length > 0);
    const folders = (scope.folders ?? []).map((p) => normalizePath(p)).filter((p) => p.length > 0);
    if (files.length === 0 && folders.length === 0) return entries;

    const fileSet = new Set(files);
    const folderPrefixes = folders.map((f) => (f.endsWith("/") ? f : `${f}/`));

    return entries.filter((entry) => {
      if (fileSet.has(entry.path)) return true;
      return folderPrefixes.some((prefix) => entry.path.startsWith(prefix));
    });
  }

  /**
   * Multi-query hybrid search using vector similarity + keyword boosting.
   * Uses nomic-embed-text search_query prefix and dual-embedding fusion.
   */
  async search(query: string, topN = 20, options?: { scope?: VaultSearchScope }): Promise<string[]> {
    this.plugin.debugLog(`Horme Brain: Search called. Index size: ${this.index.length}`);
    const canAccess = this.plugin.isLocalProviderActive() || this.plugin.settings.allowCloudRAG;
    if (!this.plugin.settings.vaultBrainEnabled || !canAccess) {
      if (!canAccess)
        this.plugin.diagnosticService.report(
          "Horme Privacy Guard",
          "Vault search blocked (Cloud Provider Active & allowCloudRAG is OFF).",
          "warning",
        );
      return [];
    }

    // Wait for the index to finish loading from disk before searching.
    // The constructor calls loadIndex() fire-and-forget, so an early search
    // (e.g. immediately after plugin load) might otherwise see an empty index.
    if (!this.isLoaded) {
      const deadline = Date.now() + 5000;
      while (!this.isLoaded && Date.now() < deadline) {
        await new Promise<void>((r) => window.setTimeout(r, 100));
      }
      if (!this.isLoaded) {
        this.plugin.diagnosticService.report(
          "Horme Brain",
          "Index not yet loaded, skipping search.",
          "warning",
        );
        return [];
      }
    }

    try {
      // 1. Refine query: remove conversational junk (Bilingual)
      const refinedQuery = query
        .toLowerCase()
        // Step 1: strip well-known leading conversational prefixes
        .replace(
          /^(?:ayúdame a encontrar|podrías ayudarme a encontrar|busca|encuentra|dime sobre|háblame de|tienes algo sobre|algún artículo sobre|alguna nota sobre|is it true that|can you help me find|tell me about|do you have anything on|search for|find|look for|i read that|i heard that|i was told that|can you confirm that|is it correct that|did you know that)\s+/i,
          "",
        )
        // Step 2: strip trailing conversational question closers
        .replace(/\?+$/, "")
        .replace(/\s*(?:right\?|correct\?|is that right|is that true|can you confirm)\s*$/i, "")
        .trim();

      // 1.5 Extract quoted terms for exact-match priority (normalized for accent-insensitivity)
      const normalizedQueryForQuotes = VaultIndexer.normalizeTextForSearch(query);
      const quotedMatches = normalizedQueryForQuotes.match(/"([^"]+)"/g) || [];
      const quotedTerms = quotedMatches.map((m) => m.replace(/"/g, ""));

      // Normalize refined query for robust keyword splitting (stripping accents)
      const normalizedRefinedQuery = VaultIndexer.normalizeTextForSearch(refinedQuery);
      const cleanedQuery = normalizedRefinedQuery.replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, " ");
      const searchTerms = cleanedQuery.split(/\s+/).filter((t) => t.length > 2);

      // 2. Truncate very long queries (e.g. user pasting whole articles) to a
      //    focused portion for embedding — models work best with focused queries.
      //    We keep the first 500 chars, which captures the topic without dilution.
      const MAX_EMBED_CHARS = 500;
      const embeddingQuery =
        refinedQuery.length > MAX_EMBED_CHARS ? refinedQuery.slice(0, MAX_EMBED_CHARS) : refinedQuery;

      // 3. Multi-query: full (truncated) query + keyword-distilled variant.
      // If Ollama rejects or times out (any error, not just "context length"),
      // fall back to keyword-only scoring instead of returning zero results.
      const { query: qPrefix } = getModelPrefixes(this.plugin.settings.ragEmbeddingModel);
      let primaryEmbedding: number[] = [];
      let secondaryEmbedding: number[] | null = null;

      try {
        primaryEmbedding = await this.plugin.embeddingService.getEmbedding(`${qPrefix}${embeddingQuery}`);
        const keyTerms = searchTerms.filter((t) => t.length > 3).join(" ");
        if (keyTerms && keyTerms !== embeddingQuery) {
          secondaryEmbedding = await this.plugin.embeddingService.getEmbedding(`${qPrefix}${keyTerms}`);
        }
      } catch {
        // Embedding failed (Ollama down, model not loaded, long-text timeout, etc.)
        // Log and continue with vector scores zeroed out — keyword bonus alone will
        // Still surface obvious matches like the exact-title case.
        this.plugin.diagnosticService.report(
          "Search",
          "Embedding failed. Falling back to keyword search.",
          "warning",
        );
      }

      const MIN_SIMILARITY = 0.1; // Lowered: keyword-only searches can still score ~0.25+

      const scope = options?.scope;
      const entries = this.filterEntriesByScope(this.index, scope);

      // ── New hybrid fusion: Reciprocal Rank Fusion (RRF) ────────────────────
      // YOLO's hybrid search fuses keyword hits + embedding hits via RRF, which
      // avoids brittle score calibration across different retrieval signals.
      if (this.plugin.settings.vaultBrainUseRrfHybridSearch) {
        const fileCache = new Map<string, string>();
        const k = Math.max(1, Math.floor(this.plugin.settings.vaultBrainRrfK || 60));
        const poolSize = Math.max(50, Math.min(250, topN * 10));

        const scored = entries.map((entry) => {
          const emb =
            typeof entry.embedding === "string"
              ? decompressEmbeddingToInt8(entry.embedding)
              : entry.embedding;

          const primaryScore =
            primaryEmbedding.length > 0 ? cosineSimilarityFloatInt8(primaryEmbedding, emb) : 0;
          const secondaryScore = secondaryEmbedding ? cosineSimilarityFloatInt8(secondaryEmbedding, emb) : 0;
          const vectorScore = Math.max(primaryScore, secondaryScore);

          const metadataScore = this.computeMetadataBonus(entry, searchTerms, quotedTerms);

          const boost = Math.max(0, Math.min(1, this.plugin.settings.highlightBoost || 0));
          const highlightMul =
            this.isHighlightEntry(entry) && this.plugin.settings.indexHighlightsEnabled ? 1 + boost : 1;

          return {
            entry,
            vectorScore: vectorScore * highlightMul,
            metadataScore: metadataScore * highlightMul,
          };
        });

        // Dense results (embedding similarity)
        const vectorRanked = scored
          .filter((s) => s.vectorScore > 0)
          .sort((a, b) => b.vectorScore - a.vectorScore)
          .slice(0, poolSize);

        // Sparse seed results (metadata-only keywords)
        const keywordSeed = scored
          .filter((s) => s.metadataScore > 0)
          .sort((a, b) => b.metadataScore - a.metadataScore)
          .slice(0, poolSize);

        // Deep scan keyword seed against actual chunk text (bounded)
        const keywordRanked: Array<{ entry: IndexEntry; keywordScore: number }> = [];
        for (const item of keywordSeed) {
          let keywordScore = item.metadataScore;
          try {
            let content = fileCache.get(item.entry.path);
            if (content === undefined) {
              const abstractFile = this.plugin.app.vault.getAbstractFileByPath(item.entry.path);
              if (abstractFile instanceof TFile) {
                content = await this.plugin.app.vault.cachedRead(abstractFile);
                fileCache.set(item.entry.path, content);
              }
            }

            if (content) {
              const isNoteLevelEntry =
                item.entry.entryType === "summary" ||
                item.entry.entryType === "highlights" ||
                (item.entry.chunkStart === 0 && item.entry.chunkEnd === 0);

              const chunkText = isNoteLevelEntry
                ? item.entry.entryType === "highlights" && item.entry.highlightsText
                  ? item.entry.highlightsText
                  : item.entry.summaryText || item.entry.tagsText
                    ? (item.entry.summaryText || "") + " " + (item.entry.tagsText || "")
                    : content.slice(0, 800)
                : content.slice(item.entry.chunkStart, item.entry.chunkEnd);

              const contentBonus = this.computeContentBonusFromChunkText(chunkText, searchTerms, quotedTerms);
              keywordScore += Math.min(contentBonus, this.plugin.settings.searchContentCap);
            }
          } catch {
            /* ignore content scan errors */
          }
          keywordRanked.push({ entry: item.entry, keywordScore });
        }

        keywordRanked.sort((a, b) => b.keywordScore - a.keywordScore);

        // If embeddings are unavailable, fall back to keyword-only list.
        if (vectorRanked.length === 0) {
          const selectedKeywordOnly = keywordRanked
            .slice(0, topN)
            .map((k) => ({ entry: k.entry, score: k.keywordScore }));
          return await this.buildSearchResultsFromEntries(selectedKeywordOnly, fileCache);
        }

        // If keywords are unavailable, fall back to vector-only list.
        if (keywordRanked.length === 0) {
          const selectedVectorOnly = vectorRanked
            .slice(0, topN)
            .map((v) => ({ entry: v.entry, score: v.vectorScore }));
          return await this.buildSearchResultsFromEntries(selectedVectorOnly, fileCache);
        }

        // RRF fusion across the union of ranked keys (1-based ranks)
        const vectorRankByKey = new Map<string, number>();
        vectorRanked.forEach((v, i) => {
          const key = this.getSearchEntryKey(v.entry);
          if (!vectorRankByKey.has(key)) vectorRankByKey.set(key, i + 1);
        });
        const keywordRankByKey = new Map<string, number>();
        keywordRanked.forEach((v, i) => {
          const key = this.getSearchEntryKey(v.entry);
          if (!keywordRankByKey.has(key)) keywordRankByKey.set(key, i + 1);
        });

        const keys = new Set<string>([...vectorRankByKey.keys(), ...keywordRankByKey.keys()]);
        const entryByKey = new Map<string, IndexEntry>();
        for (const v of vectorRanked) entryByKey.set(this.getSearchEntryKey(v.entry), v.entry);
        for (const v of keywordRanked) entryByKey.set(this.getSearchEntryKey(v.entry), v.entry);

        const fused: Array<{
          entry: IndexEntry;
          score: number;
          vectorRank?: number;
          keywordRank?: number;
        }> = [];

        for (const key of keys) {
          const entry = entryByKey.get(key);
          if (!entry) continue;
          const vr = vectorRankByKey.get(key);
          const kr = keywordRankByKey.get(key);
          let score = 0;
          if (vr !== undefined) score += 1 / (k + vr);
          if (kr !== undefined) score += 1 / (k + kr);
          fused.push({ entry, score, vectorRank: vr, keywordRank: kr });
        }

        fused.sort((a, b) => {
          if (a.score !== b.score) return b.score - a.score;
          const aDual = a.vectorRank !== undefined && a.keywordRank !== undefined;
          const bDual = b.vectorRank !== undefined && b.keywordRank !== undefined;
          if (aDual !== bDual) return aDual ? -1 : 1;
          const av = a.vectorRank ?? Number.MAX_SAFE_INTEGER;
          const bv = b.vectorRank ?? Number.MAX_SAFE_INTEGER;
          if (av !== bv) return av - bv;
          const ak = a.keywordRank ?? Number.MAX_SAFE_INTEGER;
          const bk = b.keywordRank ?? Number.MAX_SAFE_INTEGER;
          if (ak !== bk) return ak - bk;
          return a.entry.path.localeCompare(b.entry.path);
        });

        // Diversity Injection: for each summary/highlights entry, ensure the best content
        // chunk from the same note is promoted to follow it immediately.
        const injected: Array<{ entry: IndexEntry; score: number }> = [];
        for (const item of fused) {
          if (injected.length >= topN * 2) break;
          injected.push({ entry: item.entry, score: item.score });
          if (item.entry.chunkStart === 0 && item.entry.chunkEnd === 0) {
            const bestContent = fused.find(
              (s) =>
                s.entry.path === item.entry.path &&
                !(s.entry.chunkStart === 0 && s.entry.chunkEnd === 0) &&
                !injected.some((i) => this.getSearchEntryKey(i.entry) === this.getSearchEntryKey(s.entry)),
            );
            if (bestContent) injected.push({ entry: bestContent.entry, score: bestContent.score });
          }
        }

        // File-level dedup: prevent a single long note from flooding the top-N.
        const selected: Array<{ entry: IndexEntry; score: number }> = [];
        const perFileCounts = new Map<string, number>();

        const takeUpTo = (maxChunksPerFile: number) => {
          for (const item of injected) {
            if (selected.length >= topN) return;
            const current = perFileCounts.get(item.entry.path) || 0;
            if (current >= maxChunksPerFile) continue;
            const key = this.getSearchEntryKey(item.entry);
            if (selected.some((s) => this.getSearchEntryKey(s.entry) === key)) continue;
            perFileCounts.set(item.entry.path, current + 1);
            selected.push(item);
          }
        };

        takeUpTo(1);
        if (selected.length < topN) takeUpTo(3);

        this.plugin.debugLog(
          `%cHorme Brain (RRF): Top ${selected.length} search results:`,
          "color: #34d399; font-weight: bold;",
        );
        selected.forEach((s, idx) => {
          this.plugin.debugLog(
            `  %c${idx + 1}. [RRF: ${s.score.toFixed(4)}]%c ${s.entry.path}${
              s.entry.headingPath ? " > " + s.entry.headingPath : ""
            }`,
            "color: #34d399; font-weight: bold;",
            "color: inherit;",
          );
        });

        return await this.buildSearchResultsFromEntries(selected, fileCache);
      }

      // 4. Score all entries: max(primary, secondary) + metadata bonus
      const rawScored = entries
        .map((entry) => {
          const emb =
            typeof entry.embedding === "string"
              ? decompressEmbeddingToInt8(entry.embedding)
              : entry.embedding;

          const primaryScore =
            primaryEmbedding.length > 0 ? cosineSimilarityFloatInt8(primaryEmbedding, emb) : 0;
          const secondaryScore = secondaryEmbedding ? cosineSimilarityFloatInt8(secondaryEmbedding, emb) : 0;
          const vectorScore = Math.max(primaryScore, secondaryScore);

          // Metadata keyword boosting: Exact quotes (Major) + Regular terms (Minor) (Accent-insensitive!)
          let metadataBonus = 0;
          const lowerPath = VaultIndexer.normalizeTextForSearch(entry.path);
          const lowerSummary = VaultIndexer.normalizeTextForSearch(entry.summaryText || "");
          const lowerTags = VaultIndexer.normalizeTextForSearch(entry.tagsText || "");
          const lowerHighlights = VaultIndexer.normalizeTextForSearch(entry.highlightsText || "");
          const lowerHeading = VaultIndexer.normalizeTextForSearch(entry.headingPath || "");

          // 1. Quoted terms get a massive priority boost
          for (const term of quotedTerms) {
            if (
              lowerPath.includes(term) ||
              lowerSummary.includes(term) ||
              lowerTags.includes(term) ||
              lowerHighlights.includes(term) ||
              lowerHeading.includes(term)
            ) {
              metadataBonus += 0.15;
            }
          }

          // 2. Regular keyword boosting, skipping stop-words
          for (const term of searchTerms) {
            if (STOP_WORDS.has(term)) continue;
            if (lowerPath.includes(term)) metadataBonus += 0.05;
            if (lowerSummary.includes(term)) metadataBonus += 0.04;
            if (lowerTags.includes(term)) metadataBonus += 0.03;
            if (lowerHighlights.includes(term)) metadataBonus += 0.04;
            if (lowerHeading.includes(term)) metadataBonus += 0.04;
          }

          // Cap the metadata bonus so it doesn't exponentially drown out semantic vector scores
          metadataBonus = Math.min(metadataBonus, this.plugin.settings.searchMetadataCap);

          const baseScore = vectorScore + metadataBonus;
          const isHighlightEntry =
            entry.entryType === "highlights" ||
            (entry.chunkStart === 0 && entry.chunkEnd === 0 && !!entry.highlightsText);
          const boost = Math.max(0, Math.min(1, this.plugin.settings.highlightBoost || 0));
          const boosted =
            isHighlightEntry && this.plugin.settings.indexHighlightsEnabled
              ? baseScore * (1 + boost)
              : baseScore;

          return { entry, score: boosted };
        })
        .filter((s) => s.score >= MIN_SIMILARITY)
        .sort((a, b) => b.score - a.score);

      // 4.1 Content-Aware Boosting (The "Deep Scan")
      // Fetch and scan actual chunk text for top candidates to reward factual matches.
      const topCandidates = rawScored.slice(0, 50); // Cap deep scan to prevent memory exhaustion
      const scored: Array<{ entry: IndexEntry; score: number }> = [];
      const fileCache = new Map<string, string>(); // Cache content to avoid redundant reads for the same file

      for (const item of topCandidates) {
        let contentBonus = 0;
        try {
          let content = fileCache.get(item.entry.path);
          if (content === undefined) {
            const abstractFile = this.plugin.app.vault.getAbstractFileByPath(item.entry.path);
            if (abstractFile instanceof TFile) {
              content = (await this.readIndexableText(abstractFile, fileCache)) ?? "";
            }
          }

          if (content) {
            const isNoteLevelEntry = item.entry.entryType
              ? item.entry.entryType === "summary" || item.entry.entryType === "highlights"
              : item.entry.chunkStart === 0 && item.entry.chunkEnd === 0;

            const chunkText = isNoteLevelEntry
              ? item.entry.entryType === "highlights" && item.entry.highlightsText
                ? item.entry.highlightsText
                : item.entry.summaryText || item.entry.tagsText
                  ? (item.entry.summaryText || "") + " " + (item.entry.tagsText || "")
                  : content.slice(0, 800)
              : content.slice(item.entry.chunkStart, item.entry.chunkEnd);

            const normalizedChunkText = VaultIndexer.normalizeTextForSearch(chunkText);

            // Boost for search terms found in the actual body text (Accent-insensitive!)
            for (const term of searchTerms) {
              if (STOP_WORDS.has(term)) continue;
              if (normalizedChunkText.includes(term)) {
                contentBonus += 0.05; // Significant reward for factual body match
              }
            }
            // Extra boost for quoted terms in content
            for (const term of quotedTerms) {
              if (normalizedChunkText.includes(term)) contentBonus += 0.15;
            }
          }
        } catch {
          /* skip if file read fails */
        }

        scored.push({
          entry: item.entry,
          score: item.score + Math.min(contentBonus, this.plugin.settings.searchContentCap),
        });
      }

      // Re-sort after content boosting
      scored.sort((a, b) => b.score - a.score);

      // Diversity Injection: for each summary entry, ensure the best content
      // chunk from the same note is promoted to follow it immediately.
      const injected: Array<{ entry: IndexEntry; score: number }> = [];

      for (const item of scored) {
        if (injected.length >= topN * 2) break; // cap the injection pass
        if (!injected.includes(item)) {
          injected.push(item);
        }

        if (item.entry.chunkStart === 0 && item.entry.chunkEnd === 0) {
          // This is a summary entry — find the best sibling content chunk
          const bestContent = scored.find(
            (s) =>
              s.entry.path === item.entry.path &&
              !(s.entry.chunkStart === 0 && s.entry.chunkEnd === 0) &&
              !injected.includes(s),
          );
          if (bestContent) {
            injected.push(bestContent);
          }
        }
      }

      // Replace `scored` with the injection-ordered list
      // (the takeUpTo dedup below still applies, so no duplicates will
      // survive into `selected`)
      const diverseScored = injected;

      // 4.5 File-level dedup: prevent a single long note from flooding the top-N.
      // Pass 1: take max 1 chunk per file for variety.
      // Pass 2: if we still have capacity, allow up to 3 chunks per file.
      const selected: Array<{ entry: IndexEntry; score: number }> = [];
      const perFileCounts = new Map<string, number>();

      const takeUpTo = (maxChunksPerFile: number) => {
        for (const item of diverseScored) {
          if (selected.length >= topN) return;
          const current = perFileCounts.get(item.entry.path) || 0;
          if (current >= maxChunksPerFile) continue;
          if (selected.includes(item)) continue; // CRITICAL DEDUP FIX
          perFileCounts.set(item.entry.path, current + 1);
          selected.push(item);
        }
      };

      takeUpTo(1);
      if (selected.length < topN) takeUpTo(3);

      this.plugin.debugLog(
        `%cHorme Brain: Top ${selected.length} search results:`,
        "color: #34d399; font-weight: bold;",
      );
      selected.forEach((s, idx) => {
        this.plugin.debugLog(
          `  %c${idx + 1}. [Score: ${s.score.toFixed(3)}]%c ${s.entry.path}${
            s.entry.headingPath ? " > " + s.entry.headingPath : ""
          }`,
          "color: #34d399; font-weight: bold;",
          "color: inherit;",
        );
      });

      return await this.buildSearchResultsFromEntries(selected, fileCache);
    } catch (e: unknown) {
      console.error("Horme: Search failed", e);
      this.plugin.diagnosticService.report("Search", `Search failed: ${errorToMessage(e)}`);
      return [];
    }
  }

  private async buildSearchResultsFromEntries(
    selected: Array<{ entry: IndexEntry; score: number }>,
    fileCache: Map<string, string>,
  ): Promise<string[]> {
    const results: string[] = [];

    for (const { entry } of selected) {
      try {
        const abstractFile = this.plugin.app.vault.getAbstractFileByPath(entry.path);
        if (!(abstractFile instanceof TFile)) continue;

        const content = await this.readIndexableText(abstractFile, fileCache);
        if (!content) continue;

        let chunk: string;
        if (entry.chunkStart === 0 && entry.chunkEnd === 0) {
          if (entry.entryType === "highlights" && entry.highlightsText) {
            chunk = `Highlights:\n${entry.highlightsText}`;
          } else {
            const parts: string[] = [];
            if (entry.summaryText) parts.push(entry.summaryText);
            if (entry.tagsText) parts.push("Topics: " + entry.tagsText);
            if (parts.length === 0) {
              chunk = content
                .replace(/^---[\s\S]*?---\s*/m, "")
                .slice(0, 600)
                .trim();
            } else {
              chunk = parts.join("\n");
            }
          }
        } else {
          chunk = content.slice(entry.chunkStart, entry.chunkEnd).trim();
        }

        const heading = entry.headingPath ? ` (${entry.headingPath})` : "";
        if (chunk) results.push(`[From ${entry.path}${heading}]:\n${chunk}`);
      } catch {
        /* skip */
      }
    }

    return results;
  }

  private async readIndexableText(file: TFile, fileCache: Map<string, string>): Promise<string | undefined> {
    const cached = fileCache.get(file.path);
    if (cached !== undefined) return cached;

    const ext = file.extension.toLowerCase();
    let content = "";

    if (ext === "pdf") {
      const textExtractor = this.getTextExtractorApi();
      if (!textExtractor) return undefined;
      try {
        content = (await textExtractor.extractText(file)) || "";
      } catch {
        return undefined;
      }
      const maxChars = Math.max(10_000, this.plugin.settings.vaultIndexPdfMaxChars || 0);
      if (content.length > maxChars) content = content.slice(0, maxChars);
    } else {
      content = await this.plugin.app.vault.read(file);
    }

    fileCache.set(file.path, content);
    return content;
  }
  /**
   * Retrieves semantically related notes for the active file.
   * Useful for the "Connections" side panel.
   */
  async getConnections(
    activeFilePath: string,
  ): Promise<{ path: string; score: number }[] | null | undefined> {
    if (!this.plugin.settings.vaultBrainEnabled || !this.isLoaded) return null;

    const sourceEntries = this.getEntriesForPath(activeFilePath);
    if (!sourceEntries || sourceEntries.length === 0) return undefined;

    // Parse excluded folders
    const excludedPrefixes = this.plugin.settings.connectionsExcludedFolders
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    // Find the most representative embedding for the file.
    // Prefer the summary entry (chunkStart: 0) or fallback to the first content chunk.
    const representativeEntry =
      sourceEntries.find((e) => e.entryType === "summary") ||
      sourceEntries.find((e) => e.entryType === "highlights") ||
      sourceEntries.find((e) => e.chunkStart === 0 && e.chunkEnd === 0) ||
      sourceEntries[0];

    const sourceEmb =
      typeof representativeEntry.embedding === "string"
        ? decompressEmbeddingToInt8(representativeEntry.embedding)
        : representativeEntry.embedding;

    const pathScores = new Map<string, number>();

    for (const entry of this.index) {
      if (entry.path === activeFilePath) continue; // Skip source file

      // Check exclusions
      if (excludedPrefixes.some((prefix) => entry.path.startsWith(prefix))) {
        continue;
      }

      const emb =
        typeof entry.embedding === "string" ? decompressEmbeddingToInt8(entry.embedding) : entry.embedding;

      const score = cosineSimilarityInt8(sourceEmb, emb);

      const currentMax = pathScores.get(entry.path) || 0;
      if (score > currentMax) {
        pathScores.set(entry.path, score);
      }
    }

    return Array.from(pathScores.entries())
      .map(([path, score]) => ({ path, score }))
      .filter((s) => s.score >= this.plugin.settings.connectionsThreshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, this.plugin.settings.connectionsMaxResults);
  }
}
