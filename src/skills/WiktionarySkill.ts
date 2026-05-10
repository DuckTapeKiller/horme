import { requestUrl } from "obsidian";
import { Skill, SkillParameter } from "./types";

export class WiktionarySkill implements Skill {
  id = "wiktionary";
  name = "Wiktionary Lookup";
  description = "Looks up word definitions, etymology, usage notes, and conjugation details from Wiktionary. Supports multiple languages.";
  
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

  instructions = `To use this skill, output exactly: <call:wiktionary>{"word": "example", "language": "en"}</call>. The "language" parameter is optional (defaults to "en"); use "es" for Spanish Wiktionary. Use this to verify word definitions, check etymology, distinguish false friends, or confirm that a word exists in the target language.`;

  async execute(params: { word: string; language?: string }): Promise<string> {
    try {
      const { word, language } = params;
      const lang = (language || "en").toLowerCase().slice(0, 2);
      const wiktBase = `https://${lang}.wiktionary.org`;

      // Fetch the page extract for the word
      const url = `${wiktBase}/w/api.php?action=query&titles=${encodeURIComponent(word)}`
        + `&prop=extracts&explaintext=1&format=json&origin=*`;
      const res = await requestUrl({ url });
      const pages = res.json.query?.pages;

      if (!pages) {
        return `No Wiktionary (${lang}) entry found for "${word}".`;
      }

      const pageId = Object.keys(pages)[0];
      if (pageId === "-1") {
        // Page doesn't exist — try search as fallback
        return await this.searchFallback(word, lang, wiktBase);
      }

      const extract = pages[pageId]?.extract;
      if (!extract || extract.trim().length === 0) {
        return `Wiktionary (${lang}) page exists for "${word}" but contains no extractable text.`;
      }

      // Trim to a useful length — Wiktionary entries can be enormous
      const trimmed = extract.length > 2000 
        ? extract.substring(0, 1950) + "\n\n...[TRUNCATED]"
        : extract;

      return `## Wiktionary: "${word}" (${lang})\n\n${trimmed}\n\n**Source:** ${wiktBase}/wiki/${encodeURIComponent(word)}`;
    } catch (e) {
      console.error("Horme Wiktionary Skill Error:", e);
      throw e;
    }
  }

  private async searchFallback(word: string, lang: string, wiktBase: string): Promise<string> {
    try {
      const searchUrl = `${wiktBase}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(word)}&srlimit=3&format=json&origin=*`;
      const searchRes = await requestUrl({ url: searchUrl });
      const results = searchRes.json.query?.search;

      if (!results || results.length === 0) {
        return `No Wiktionary (${lang}) entry found for "${word}". The word may not exist in this language or may be misspelled.`;
      }

      const suggestions = results.map((r: any) => r.title).join(", ");
      return `No exact Wiktionary (${lang}) entry for "${word}". Did you mean: ${suggestions}?`;
    } catch {
      return `No Wiktionary (${lang}) entry found for "${word}".`;
    }
  }
}
