import { requestUrlWithTimeout } from "../utils/requestWithTimeout";
import { Skill, SkillParameter } from "./types";
import { errorToMessage, getStringProp } from "../utils/TypeGuards";

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

      const searchUrl = `https://www.britannica.com/search?query=${encodeURIComponent(query)}`;
      const searchRes = await requestUrlWithTimeout({ url: searchUrl }, 12000);
      const searchHtml = searchRes.text;

      const linkRegex = /<a[^>]*class="font-weight-bold font-18"[^>]*href="([^"]+)"/i;
      const match = searchHtml.match(linkRegex);
      if (!match) return `No Britannica article found for "${query}".`;

      const href = match[1];
      if (typeof href !== "string" || !href.startsWith("/") || href.startsWith("//"))
        return `No valid Britannica article link found for "${query}".`;

      const articleUrl = "https://www.britannica.com" + href;
      const articleRes = await requestUrlWithTimeout({ url: articleUrl }, 12000);

      const parser = new DOMParser();
      const doc = parser.parseFromString(articleRes.text, "text/html");
      doc
        .querySelectorAll("script, style, noscript, iframe, nav, footer, header, aside, .ad-container")
        .forEach((el) => el.remove());

      const paragraphs: string[] = [];
      doc.querySelectorAll("p").forEach((el) => {
        const text = (el.textContent ?? "").trim();
        if (
          text.length > 100 &&
          !text.includes("editors will review") &&
          !text.includes("premium.britannica.com")
        ) {
          paragraphs.push(text.replace(/–/g, "-").replace(/“/g, "«").replace(/”/g, "»").replace(/’/g, "'"));
        }
        if (paragraphs.length >= 3) return;
      });

      if (paragraphs.length === 0) return `Article found but no text extracted: ${articleUrl}`;

      return `## Britannica: "${query}"\n\n${paragraphs.join("\n\n")}\n\n<!-- ${articleUrl} -->`;
    } catch (e: unknown) {
      console.error("Horme Britannica Skill Error:", e);
      return `Britannica error: ${errorToMessage(e)}`;
    }
  }
}
