import { requestUrl } from "obsidian";
import { Skill, SkillParameter } from "./types";
import { asArray, errorToMessage, getRecordProp, getStringProp, isRecord } from "../utils/TypeGuards";

export class WikipediaSkill implements Skill {
  id = "wikipedia";
  name = "Wikipedia Search";
  description = "Searches Wikipedia for factual information, detailed article sections, and verification of claims. Supports multiple languages.";
  terminal = true;
  
  parameters: SkillParameter[] = [
    {
      name: "query",
      type: "string",
      description: "The search term or claim to verify.",
      required: true
    },
    {
      name: "language",
      type: "string",
      description: "Wikipedia language code (e.g. 'en' for English, 'es' for Spanish). Defaults to 'en'.",
      required: false
    }
  ];

  instructions = `To use this skill, output exactly: <call:wikipedia>{"query": "your search term", "language": "en"}</call>. The "language" parameter is optional (defaults to "en"); use "es" for Spanish Wikipedia, "fr" for French, etc. Use this whenever the user asks for a factual verification, when you need to confirm a historical, scientific, or geographic detail, or when fact-checking claims.`;

  async execute(params: unknown): Promise<string> {
    try {
      const query = getStringProp(params, "query");
      if (!query) return `Invalid parameters for ${this.name}: expected {"query": string, "language"?: string}.`;
      const language = getStringProp(params, "language");
      const lang = (language || "en").toLowerCase().slice(0, 2);
      const wikiBase = `https://${lang}.wikipedia.org`;
      
      // 1. Search for the most relevant page
      const searchUrl = `${wikiBase}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=3&format=json&origin=*`;
      const searchRes = await requestUrl({ url: searchUrl });
      const searchData: unknown = searchRes.json;
      
      const queryObj = getRecordProp(searchData, "query");
      const searchArr = asArray(getRecordProp(queryObj, "search")) ?? [];
      if (searchArr.length === 0) {
        return `No Wikipedia (${lang}) results found for "${query}".`;
      }

      const bestMatch = searchArr[0];
      const pageTitle = getStringProp(bestMatch, "title");
      if (!pageTitle) return `No Wikipedia (${lang}) results found for "${query}".`;

      // 2. Fetch the summary for context
      const summaryUrl = `${wikiBase}/api/rest_v1/page/summary/${encodeURIComponent(pageTitle.replace(/ /g, "_"))}`;
      const summaryRes = await requestUrl({ url: summaryUrl });
      const summaryData: unknown = summaryRes.json;

      let output = `## Wikipedia: ${pageTitle} (${lang})\n\n`;

      const extractSummary = getStringProp(summaryData, "extract");
      if (extractSummary) {
        output += `**Summary:** ${extractSummary}\n\n`;
      }

      // 3. Fetch relevant sections from the full article for deeper fact-checking
      const sectionsUrl = `${wikiBase}/w/api.php?action=parse&page=${encodeURIComponent(pageTitle)}&prop=sections&format=json&origin=*`;
      try {
        const sectionsRes = await requestUrl({ url: sectionsUrl });
        const sectionsData: unknown = sectionsRes.json;
        
        const parseObj = getRecordProp(sectionsData, "parse");
        const sections = asArray(getRecordProp(parseObj, "sections")) ?? [];
        if (sections.length > 0) {
          // Find sections most relevant to the query (top-level sections only, max 3)
          const topSections = sections
            .filter((s) => {
              const level = (getRecordProp(s, "toclevel"));
              const line = getStringProp(s, "line") ?? "";
              return typeof level === "number" && level <= 2 && line.length > 0;
            })
            .slice(0, 6);

          if (topSections.length > 0) {
            // Fetch plain text extract of the page with section info
            const extractUrl = `${wikiBase}/w/api.php?action=query&titles=${encodeURIComponent(pageTitle)}&prop=extracts&exintro=0&explaintext=1&exsectionformat=plain&exchars=3000&format=json&origin=*`;
            const extractRes = await requestUrl({ url: extractUrl });
            const extractJson: unknown = extractRes.json;
            const pages = getRecordProp(getRecordProp(extractJson, "query"), "pages");
            
            if (isRecord(pages)) {
              const pageId = Object.keys(pages)[0];
              const pageObj = pages[pageId];
              const fullExtract = getStringProp(pageObj, "extract");
              
              if (fullExtract) {
                // Find query-relevant portions of the extract
                const relevantContent = this.extractRelevantPassages(fullExtract, query);
                if (relevantContent) {
                  output += `**Relevant details:**\n${relevantContent}\n\n`;
                }
              }
            }
          }
        }
      } catch {
        // Section fetch failed — summary is still available
      }

      // 4. Source URL
      const contentUrls = getRecordProp(summaryData, "content_urls");
      const desktop = getRecordProp(contentUrls, "desktop");
      const pageUrl = getStringProp(desktop, "page");
      if (pageUrl) {
        output += `\n<!-- ${pageUrl} -->`;
      }

      // Cap total output
      if (output.length > 3000) {
        output = output.substring(0, 2950) + "\n\n...[TRUNCATED for efficiency]";
      }

      return output;
    } catch (e: unknown) {

      console.error("Horme Wikipedia Skill Error:", e);
      throw new Error(errorToMessage(e));
    }
  }

  /**
   * Extracts passages from the full article text that are most relevant to the query.
   * Splits by sections (double newline + heading pattern) and scores by keyword overlap.
   */
  private extractRelevantPassages(fullText: string, query: string): string {
    const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 3);
    if (queryTerms.length === 0) return "";

    // Split into paragraphs
    const paragraphs = fullText.split(/\n\n+/).filter(p => p.trim().length > 30);

    // Score each paragraph by query term overlap
    const scored = paragraphs.map(p => {
      const lower = p.toLowerCase();
      const hits = queryTerms.filter(t => lower.includes(t)).length;
      return { text: p.trim(), score: hits };
    });

    // Take top 3 paragraphs that have at least one query term match
    const relevant = scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    if (relevant.length === 0) return "";

    return relevant.map(r => r.text).join("\n\n");
  }
}
