import { requestUrl } from "obsidian";
import { Skill, SkillParameter } from "./types";
import { asArray, errorToMessage, getRecordProp, getStringProp, isRecord } from "../utils/TypeGuards";

export class WiktionarySkill implements Skill {
  id = "wiktionary";
  name = "Wiktionary Lookup";
  description = "Looks up word definitions, etymology, usage notes, and conjugation details from Wiktionary. Supports multiple languages.";
  terminal = true;
  
  parameters: SkillParameter[] = [
    {
      name: "word",
      type: "string",
      description: "The word to look up.",
      required: true
    },
    {
      name: "language",
      type: "string",
      description: "Wiktionary language code (e.g. 'en' for English, 'es' for Spanish). Defaults to 'en'.",
      required: false
    }
  ];

  instructions = `To use this skill, output exactly: <call:wiktionary>{"word": "example", "language": "en"}</call>. IMPORTANT: Always infer the correct language code from the word itself. If the word is Spanish, use "es". If it is French, use "fr". If it is German, use "de". If it is Italian, use "it". If it is Portuguese, use "pt". Only use "en" if the word is genuinely English. The language code controls which national Wiktionary is queried (e.g. "es" queries es.wiktionary.org). Use this to verify word definitions, check etymology, distinguish false friends, or confirm that a word exists in the target language.`;

  async execute(params: unknown): Promise<string> {
    try {
      const word = getStringProp(params, "word");
      if (!word) return `Invalid parameters for ${this.name}: expected {"word": string, "language"?: string}.`;
      const language = getStringProp(params, "language");
      const lang = (language || "en").toLowerCase().slice(0, 2);
      const wiktBase = `https://${lang}.wiktionary.org`;

      // Fetch the page extract for the word
      const url = `${wiktBase}/w/api.php?action=query&titles=${encodeURIComponent(word)}`
        + `&prop=extracts&explaintext=1&format=json&origin=*`;
      const res = await requestUrl({ url });
      const json: unknown = res.json;
      const pages = getRecordProp(getRecordProp(json, "query"), "pages");

      if (!isRecord(pages)) {
        return `No Wiktionary (${lang}) entry found for "${word}".`;
      }

      const pageId = Object.keys(pages)[0];
      if (pageId === "-1") {
        // Page doesn't exist — try search as fallback
        return await this.searchFallback(word, lang, wiktBase);
      }

      const extract = getStringProp(pages[pageId], "extract");
      if (!extract || extract.trim().length === 0) {
        return `Wiktionary (${lang}) page exists for "${word}" but contains no extractable text.`;
      }

      // Trim to a useful length — Wiktionary entries can be enormous
      const raw = extract.length > 2000
        ? extract.substring(0, 1950) + "\n\n...[TRUNCATED]"
        : extract;

      const trimmed = this.wikitextToMarkdown(raw);

      return `## Wiktionary: "${word}" (${lang})\n\n${trimmed}\n\n<!-- ${wiktBase}/wiki/${encodeURIComponent(word)} -->`;
    } catch (e: unknown) {

      console.error("Horme Wiktionary Skill Error:", e);
      throw new Error(errorToMessage(e));
    }
  }

  private async searchFallback(word: string, lang: string, wiktBase: string): Promise<string> {
    try {
      const searchUrl = `${wiktBase}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(word)}&srlimit=3&format=json&origin=*`;
      const searchRes = await requestUrl({ url: searchUrl });
      const json: unknown = searchRes.json;
      const results = asArray(getRecordProp(getRecordProp(json, "query"), "search")) ?? [];

      if (results.length === 0) {
        return `No Wiktionary (${lang}) entry found for "${word}". The word may not exist in this language or may be misspelled.`;
      }

      const titles: string[] = [];
      for (const r of results) {
        const title = getStringProp(r, "title");
        if (title) titles.push(title);
      }
      const suggestions = titles.join(", ");
      return `No exact Wiktionary (${lang}) entry for "${word}". Did you mean: ${suggestions}?`;
    } catch {
      return `No Wiktionary (${lang}) entry found for "${word}".`;
    }
  }

  private wikitextToMarkdown(text: string): string {
    return text
      // ==== Level 4 headings ==== → #### heading
      .replace(/^={4}([^=]+)={4}\s*$/gm, (_: string, t: string) => `#### ${t.trim()}`)
      // === Level 3 headings === → ### heading
      .replace(/^={3}([^=]+)={3}\s*$/gm, (_: string, t: string) => `### ${t.trim()}`)
      // == Level 2 headings == → ## heading
      .replace(/^={2}([^=]+)={2}\s*$/gm, (_: string, t: string) => `## ${t.trim()}`)
      // Collapse 3+ consecutive blank lines into 2
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
}
