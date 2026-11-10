import { requestUrlWithTimeout } from "../utils/requestWithTimeout";
import { searchWeb, WebHit } from "../utils/webResearch";
import { Skill, SkillParameter } from "./types";
import { errorToMessage, asArray, getStringProp } from "../utils/TypeGuards";

export class BritannicaSkill implements Skill {
  id = "britannica";
  name = "Britannica Search";
  description =
    "Searches Encyclopaedia Britannica for authoritative, curated articles on a topic. Useful for academic-grade definitions, historical context, and cross-referencing Wikipedia findings.";
  terminal = true;
  primaryParam = "query";

  parameters: SkillParameter[] = [
    {
      name: "query",
      type: "string",
      description: "The topic or term to look up on Britannica.",
      required: true,
    },
  ];

  instructions =
    'To use this skill, output exactly: <call:britannica>{"query": "your search term"}</call>. ' +
    "Use this for academic-grade encyclopaedic lookups, or to cross-reference Wikipedia with a second authoritative source.";

  async execute(params: unknown): Promise<string> {
    try {
      const query = getStringProp(params, "query");
      if (!query) return `Invalid parameters for ${this.name}: expected {"query": string}.`;

      // The search page fills its results in with JavaScript, so its HTML never
      // holds a result link; the autocomplete endpoint answers with JSON.
      const searchUrl = `https://www.britannica.com/ajax/search/autocomplete?query=${encodeURIComponent(query)}`;
      const searchRes = await requestUrlWithTimeout({ url: searchUrl, throw: false }, 12000);
      if (searchRes.status !== 200) return `Britannica search failed (HTTP ${searchRes.status}).`;
      let hits: unknown;
      try {
        hits = searchRes.json as unknown;
      } catch {
        return `Britannica search returned an unexpected answer for "${query}".`;
      }
      let href = getStringProp((asArray(hits) ?? [])[0], "url");
      if (!href) {
        // The autocomplete only matches article titles ("Peter Abelard", not
        // "Penny Black"); a web search limited to the site finds the article.
        const web = await searchWeb(`site:britannica.com ${query}`, 5).catch((): WebHit[] => []);
        const found = web.find((h) => /^https:\/\/www\.britannica\.com\/(?!search)/.test(h.url));
        if (found) href = found.url.replace("https://www.britannica.com", "");
      }
      if (!href) return `No Britannica article found for "${query}".`;
      if (!href.startsWith("/") || href.startsWith("//"))
        return `No valid Britannica article link found for "${query}".`;

      const articleUrl = "https://www.britannica.com" + href;
      const articleRes = await requestUrlWithTimeout({ url: articleUrl }, 12000);

      const parser = new DOMParser();
      const doc = parser.parseFromString(articleRes.text, "text/html");
      doc
        .querySelectorAll("script, style, noscript, iframe, nav, footer, header, aside, .ad-container")
        .forEach((el) => el.remove());

      // The first three substantial paragraphs, as written. (A `return` inside
      // forEach never stopped the loop, so whole articles were returned, and the
      // quotation marks of English text were rewritten as guillemets.)
      const paragraphs: string[] = [];
      for (const el of Array.from(doc.querySelectorAll("p"))) {
        const text = (el.textContent ?? "").trim();
        if (
          text.length > 100 &&
          !text.includes("editors will review") &&
          !text.includes("premium.britannica.com")
        ) {
          paragraphs.push(text);
        }
        if (paragraphs.length >= 3) break;
      }

      if (paragraphs.length === 0) return `Article found but no text extracted: ${articleUrl}`;

      return `## Britannica: "${query}"\n\n${paragraphs.join("\n\n")}\n\n<!-- ${articleUrl} -->`;
    } catch (e: unknown) {
      console.error("Horme Britannica Skill Error:", e);
      return `Britannica error: ${errorToMessage(e)}`;
    }
  }
}
