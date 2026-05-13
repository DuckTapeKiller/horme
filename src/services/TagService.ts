import { App, Notice, TFile } from "obsidian";
import type { UnknownRecord } from "../utils/TypeGuards";

export class TagService {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  async applyTags(file: TFile, tags: string[]) {
    const toAdd = Array.from(new Set(tags.map((t) => t.toLowerCase())));
    const fileManager = (this.app as unknown as { fileManager?: { processFrontMatter?: (file: TFile, cb: (fm: UnknownRecord) => void) => Promise<void> } })
      .fileManager;
    const fmApi = fileManager?.processFrontMatter;

    if (typeof fmApi === "function") {
      await fmApi(file, (fm) => {
        const existing = this.toArray(fm["tags"]);
        const seen = new Set(existing.map(t => this.normalizeKey(t)));
        const merged = [...existing];
        
        for (const t of toAdd) {
          const key = this.normalizeKey(t);
          if (!seen.has(key)) {
            seen.add(key);
            merged.push(t);
          }
        }
        fm["tags"] = merged;
      });
    } else {
      new Notice("Horme: Frontmatter API not available.");
    }
  }

  private toArray(v: unknown): string[] {
    if (Array.isArray(v)) return v.filter((x) => typeof x === "string");
    if (typeof v === "string") {
      const s = v.trim();
      if (!s) return [];
      if (s.includes(",")) return s.split(",").map((x) => x.trim()).filter(Boolean);
      return [s];
    }
    return [];
  }

  private normalizeKey(t: string): string {
    return t
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/_+/g, "_")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  }

  stripFrontmatter(text: string): string {
    if (!text.startsWith("---")) return text;
    const match = text.match(/^---\s*[\r\n]+[\s\S]*?[\r\n]+---\s*[\r\n]+/);
    if (!match) return text;
    return text.slice(match[0].length);
  }

  rankCandidates(noteText: string, tags: string[]): string[] {
    const norm = (s: string) =>
      s
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");

    const textNorm = norm(noteText);
    const tokens = new Set(
      norm(noteText)
        .replace(/[`~!@%^&*()=+[{\]}\\|;:'",.<>/?]/g, " ")
        .split(/\s+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 3)
    );

    const scored: Array<{ tag: string; score: number }> = [];
    for (const tag of tags) {
      const leaf = tag.includes("/") ? tag.split("/").pop() || tag : tag;
      const leafNorm = norm(leaf);
      const tagNorm = norm(tag);
      const leafWordsNorm = leafNorm.replace(/_/g, " ");
      let score = 0;
      if (tokens.has(leafNorm)) score += 8;
      if (textNorm.includes(tagNorm)) score += 6;
      if (textNorm.includes(leafWordsNorm)) score += 3;
      const parts = leafWordsNorm.split(/\s+/).filter((p) => p.length >= 3);
      if (parts.length && parts.every((p) => tokens.has(p))) score += 6;
      if (score > 0) scored.push({ tag, score });
    }

    scored.sort((a, b) => b.score - a.score || a.tag.localeCompare(b.tag));
    const scoredSet = new Set(scored.map(s => s.tag));
    const rest = tags.filter(t => !scoredSet.has(t));
    return [...scored.map(s => s.tag), ...rest];
  }
}
