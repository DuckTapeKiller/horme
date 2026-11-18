import { TFile, normalizePath } from "obsidian";
import HormePlugin from "../../main";
import { KeywordIndex } from "./KeywordIndex";
import {
  cosineSimilarityFloatInt8,
  cosineSimilarityInt8,
  decompressEmbeddingToInt8,
  getModelPrefixes,
} from "../utils/VectorUtils";
import { errorToMessage } from "../utils/TypeGuards";
import type { IndexEntry, VaultIndexer } from "./VaultIndexer";

export type VaultSearchScope = {
  files?: string[];
  folders?: string[];
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

/**
 * Searching Vault Brain: hybrid search (vectors from the embedding server
 * fused with keyword matches in titles, headings, tags, summaries and text),
 * and the related notes for the Connections panel. It reads the index the
 * VaultIndexer builds and keeps.
 */
export class VaultSearch {
  constructor(
    private plugin: HormePlugin,
    private indexer: VaultIndexer,
  ) {}

  private static normalizeTextForSearch(text: string): string {
    return text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  }

  /** BM25 word index over passage text (see KeywordIndex), kept in step with the vault index. */
  private keywordIndex = new KeywordIndex();

  /** Per note: the index state its words were read from ("mtime:entries"). */
  private keywordSignature = new Map<string, string>();

  /** Brings the word index up to date: notes added, changed or removed since the last search. */
  private async refreshKeywordIndex(fileCache: Map<string, string>): Promise<void> {
    for (const path of this.keywordIndex.paths()) {
      if (!this.indexer.pathIndex.has(path)) {
        this.keywordIndex.removePath(path);
        this.keywordSignature.delete(path);
      }
    }
    for (const [path, list] of this.indexer.pathIndex) {
      const signature = `${list.reduce((m, e) => Math.max(m, e.mtime), 0)}:${list.length}`;
      if (this.keywordSignature.get(path) === signature) continue;
      const file = this.plugin.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;
      let content = "";
      try {
        content = (await this.readIndexableText(file, fileCache)) || "";
      } catch {
        continue;
      }
      const passages = list.map((e) => {
        let text: string;
        if (e.chunkStart === 0 && e.chunkEnd === 0) {
          text =
            e.entryType === "highlights"
              ? e.highlightsText || ""
              : `${e.summaryText || ""} ${e.tagsText || ""}`;
        } else {
          text = content.slice(e.chunkStart, e.chunkEnd);
        }
        return { key: this.getSearchEntryKey(e), text: `${file.basename} ${e.headingPath || ""}\n${text}` };
      });
      this.keywordIndex.setPath(path, passages);
      this.keywordSignature.set(path, signature);
    }
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
    const lowerPath = VaultSearch.normalizeTextForSearch(entry.path);
    const lowerSummary = VaultSearch.normalizeTextForSearch(entry.summaryText || "");
    const lowerTags = VaultSearch.normalizeTextForSearch(entry.tagsText || "");
    const lowerHighlights = VaultSearch.normalizeTextForSearch(entry.highlightsText || "");
    const lowerHeading = VaultSearch.normalizeTextForSearch(entry.headingPath || "");

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
    const normalizedChunkText = VaultSearch.normalizeTextForSearch(chunkText);

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
    this.plugin.debugLog(`Horme Brain: Search called. Index size: ${this.indexer.index.length}`);
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
    if (!this.indexer.isLoaded) {
      const deadline = Date.now() + 5000;
      while (!this.indexer.isLoaded && Date.now() < deadline) {
        await new Promise<void>((r) => window.setTimeout(r, 100));
      }
      if (!this.indexer.isLoaded) {
        this.plugin.diagnosticService.report(
          "Horme Brain",
          "Index not yet loaded, skipping search.",
          "warning",
        );
        return [];
      }
    }

    // Which model the server has now decides whether the index can be searched.
    await this.plugin.embeddingService.resolveEmbeddingModelName();
    if (!this.indexer.isSpaceCompatible()) {
      this.indexer.checkEmbeddingSpace(false);
      return [];
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
      const normalizedQueryForQuotes = VaultSearch.normalizeTextForSearch(query);
      const quotedMatches = normalizedQueryForQuotes.match(/"([^"]+)"/g) || [];
      const quotedTerms = quotedMatches.map((m) => m.replace(/"/g, ""));

      // Normalize refined query for robust keyword splitting (stripping accents)
      const normalizedRefinedQuery = VaultSearch.normalizeTextForSearch(refinedQuery);
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
      const { query: qPrefix } = getModelPrefixes(
        await this.plugin.embeddingService.resolveEmbeddingModelName(),
      );
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
      const entries = this.filterEntriesByScope(this.indexer.index, scope);

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

        // Sparse results: BM25 over the words of every passage (a name, a date or
        // a price in the body counts, rare words above common ones), plus the
        // title, tag and heading matches that used to be the only keyword signal.
        const keywordSeed = scored
          .filter((s) => s.metadataScore > 0)
          .sort((a, b) => b.metadataScore - a.metadataScore)
          .slice(0, poolSize);
        await this.refreshKeywordIndex(fileCache);
        const entryByScopeKey = new Map(entries.map((e) => [this.getSearchEntryKey(e), e]));
        const bm25 = this.keywordIndex.search(query, poolSize, (key) => entryByScopeKey.has(key));
        const topBm25 = bm25[0]?.score || 1;
        const keywordByKey = new Map<string, { entry: IndexEntry; keywordScore: number }>();
        for (const hit of bm25) {
          const entry = entryByScopeKey.get(hit.key);
          if (entry) keywordByKey.set(hit.key, { entry, keywordScore: hit.score / topBm25 });
        }
        for (const item of keywordSeed) {
          const key = this.getSearchEntryKey(item.entry);
          const prev = keywordByKey.get(key);
          const bonus = 2 * item.metadataScore;
          if (prev) prev.keywordScore += bonus;
          else keywordByKey.set(key, { entry: item.entry, keywordScore: bonus });
        }
        const keywordRanked = [...keywordByKey.values()];
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
          const lowerPath = VaultSearch.normalizeTextForSearch(entry.path);
          const lowerSummary = VaultSearch.normalizeTextForSearch(entry.summaryText || "");
          const lowerTags = VaultSearch.normalizeTextForSearch(entry.tagsText || "");
          const lowerHighlights = VaultSearch.normalizeTextForSearch(entry.highlightsText || "");
          const lowerHeading = VaultSearch.normalizeTextForSearch(entry.headingPath || "");

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

            const normalizedChunkText = VaultSearch.normalizeTextForSearch(chunkText);

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
                .replace(/^---\r?\n[\s\S]*?\r?\n---[^\S\r\n]*(?:\r?\n|$)/, "")
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
      const textExtractor = this.indexer.getTextExtractorApi();
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
  getConnections(activeFilePath: string): { path: string; score: number }[] | null | undefined {
    if (
      !this.plugin.settings.vaultBrainEnabled ||
      !this.indexer.isLoaded ||
      !this.indexer.isSpaceCompatible()
    )
      return null;

    const sourceEntries = this.indexer.getEntriesForPath(activeFilePath);
    if (!sourceEntries || sourceEntries.length === 0) return undefined;

    // Excluded folders: whole folders, in any letter case. "Temp" leaves out
    // "Temp/…" but not "Templates/…" or "Temperature.md".
    const excludedFolders = this.plugin.settings.connectionsExcludedFolders
      .split(",")
      .map((s) =>
        normalizePath(s.trim())
          .replace(/^\/+|\/+$/g, "")
          .toLowerCase(),
      )
      .filter((s) => s.length > 0 && s !== "/");
    const isInExcludedFolder = (path: string): boolean => {
      const lower = path.toLowerCase();
      return excludedFolders.some((folder) => lower.startsWith(folder + "/"));
    };

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

    for (const entry of this.indexer.index) {
      if (entry.path === activeFilePath) continue; // Skip source file

      // Check exclusions
      if (isInExcludedFolder(entry.path)) {
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
