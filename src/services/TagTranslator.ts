import { TFile, Notice, normalizePath } from "obsidian";
import HormePlugin from "../../main";
import type { AiProvider as TagProviderId } from "../types";
import type { AiProvider as AiProviderClient } from "../providers/AiProvider";
import { createProvider } from "../providers/createProvider";
import { isLocalServer, keepsNotesPrivate } from "../utils/providerAccess";
import { errorToMessage } from "../utils/TypeGuards";
import { providerModel } from "../providers/registry";

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

/**
 * Tag translation for bilingual search: while Vault Brain indexes, each tag is
 * also stored in a second language, through the tag translation provider
 * (with a local fallback when a cloud one fails), and remembered on disk so a
 * tag is translated once.
 */
export class TagTranslator {
  constructor(private plugin: HormePlugin) {}

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

  /** Forgets every translation, in memory and on disk (the index is being deleted). */
  async forgetAll(): Promise<void> {
    this.tagTranslationCache.clear();
    const adapter = this.plugin.app.vault.adapter;
    const cachePath = this.getCachePath();
    if (await adapter.exists(cachePath)) await adapter.remove(cachePath);
  }

  /** A full rebuild starts: translations are made afresh, and counted for its report. */
  startRun(): void {
    this.tagTranslationCache.clear();
    this.tagTranslationRunStats = null;
  }

  /** After a rebuild: what was translated, and how often the cloud provider needed the local fallback. */
  reportRun(): void {
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
    const runStats = this.tagTranslationRunStats;
    if (runStats?.primaryIsCloud && runStats.allowCloudTagTranslation) {
      this.plugin.diagnosticService.report(
        "Tag Translation",
        `Tag translation: cloud ok ${runStats.cloudOkChunks} chunks, fallback used ${runStats.fallbackUsedChunks} chunks, total failures ${runStats.totalFailures}.`,
        "info",
      );
    }
  }

  // Cache of Spanish tag string → bilingual tag string.
  // Built during indexing to avoid redundant LLM calls for notes sharing the same tags.
  // Cleared when the plugin unloads (in-memory only — intentionally not persisted).
  private tagTranslationCache: Map<string, string> = new Map();

  private hasReportedEmptyTagTranslationModel = false;

  private tagTranslationRunStats: TagTranslationRunStats | null = null;

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
  collectShadowTags(content: string, file: TFile): string[] {
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

      if (leaf && !TagTranslator.GENERIC_TAG_NODES.has(leaf.toLowerCase())) {
        uniqueTerms.add(leaf);
      }

      for (const p of path) {
        if (p && !TagTranslator.GENERIC_TAG_NODES.has(p.toLowerCase())) {
          uniqueTerms.add(p);
        }
      }
    }

    return Array.from(uniqueTerms).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }

  async preTranslateTags(files: TFile[]) {
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
              .filter((line) => /(?:^|[^\p{L}\p{N}_])t\s*\d+\s*(?:->|◈|:|=>|=)/u.test(line));

            // 2. Build the lookup map matching index values back to terms safely
            const translationMap = new Map<string, string>();
            lines.forEach((line) => {
              const match = line.match(/(?:^|[^\p{L}\p{N}_])t\s*(\d+)\s*(?:->|◈|:|=>|=)\s*(.*)/u);
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

  translateTagsBilingually(spanishTags: string): string {
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
        if (leaf && !TagTranslator.GENERIC_TAG_NODES.has(leaf.toLowerCase())) {
          uniqueLeaves.add(leaf);
        }
        for (const p of path) {
          if (p && !TagTranslator.GENERIC_TAG_NODES.has(p.toLowerCase())) {
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
          .filter((line) => /(?:^|[^\p{L}\p{N}_])t\s*\d+\s*(?:->|◈|:|=>|=)/u.test(line));

        const translationMap = new Map<number, string>();
        lines.forEach((line) => {
          const match = line.match(/(?:^|[^\p{L}\p{N}_])t\s*(\d+)\s*(?:->|◈|:|=>|=)\s*(.*)/u);
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

  /** Not one of the local servers: when it fails, the local fallback translates. */
  private isCloudProvider(provider: TagProviderId): boolean {
    return !isLocalServer(provider);
  }

  /**
   * The model that translates tags on a provider: the translation model when
   * set and the provider runs locally, else the provider's own chat model.
   */
  private getTagTranslationModelFor(provider: TagProviderId): string {
    const own = providerModel(this.plugin.settings, provider);
    if (!isLocalServer(provider)) return own;
    return (this.plugin.settings.tagTranslationModel || "").trim() || own;
  }

  private createProvider(provider: TagProviderId, maxTokens: number): AiProviderClient {
    return createProvider(this.plugin, provider, maxTokens);
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
    // Tag names reach a cloud provider only with consent; the OpenAI-compatible
    // server the user says is theirs needs none, but still has the local fallback.
    if (
      keepsNotesPrivate(s, primary, this.getTagTranslationModelFor(primary)) ||
      s.allowCloudTagTranslation
    ) {
      chainIds.push(primary);
    }
    if (this.isCloudProvider(primary)) {
      chainIds.push(fallback);
    }

    const unique = Array.from(new Set(chainIds));
    const out: Array<{ id: TagProviderId; provider: AiProviderClient; model: string }> = [];

    for (const id of unique) {
      const model = this.getTagTranslationModelFor(id);
      // llama.cpp answers with its loaded model when none is named.
      if (!model && id !== "llamacpp") continue;
      out.push({ id, provider: this.createProvider(id, maxTokens), model });
    }

    return out;
  }
}
