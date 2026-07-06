import { requestUrl } from "obsidian";
import { Skill, SkillParameter } from "./types";
import { errorToMessage, getStringProp, getRecordProp, asArray, isRecord } from "../utils/TypeGuards";

const REQUEST_TIMEOUT = 12000;
const MAX_PAGE_CHARS = 6000;
const MAX_QUERIES = 5;

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export class DeepResearchSkill implements Skill {
  id = "deep_research";
  name = "Deep Research";
  description =
    "Runs multiple research queries in parallel — Wikipedia summaries, DuckDuckGo results, and page fetches — and compiles a research dossier. Use this for multi-faceted questions that need several lookups.";
  terminal = false;
  primaryParam = "queries";

  parameters: SkillParameter[] = [
    {
      name: "queries",
      type: "array",
      items: { type: "string" },
      description:
        "One to five research queries. Each query is searched independently via Wikipedia and DuckDuckGo.",
      required: true,
    },
  ];

  instructions =
    'To use this skill, output exactly: <call:deep_research>{"queries": ["query one", "query two"]}</call>. ' +
    "Use this when the user's question needs information from multiple angles or topics. " +
    "Each query runs Wikipedia + DuckDuckGo lookups and fetches top results. " +
    "Prefer this over individual wikipedia/ddg_search calls when you need 2+ lookups.";

  async execute(params: unknown): Promise<string> {
    try {
      const raw = isRecord(params) ? params.queries : undefined;
      const queries = this.parseQueries(raw);
      if (!queries.length) return "Invalid parameters: expected {\"queries\": [\"...\", \"...\"]}";

      const dossiers = await Promise.all(queries.map((q) => this.researchQuery(q)));
      let output = "# Research Dossier\n\n";
      for (const d of dossiers) {
        output += d + "\n\n---\n\n";
      }

      if (output.length > 15000) {
        output = output.substring(0, 14900) + "\n\n...[TRUNCATED]";
      }
      return output.trim();
    } catch (e: unknown) {
      console.error("Horme Deep Research Skill Error:", e);
      return `Error: Deep research failed. ${errorToMessage(e)}`;
    }
  }

  private parseQueries(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const item of raw) {
      if (typeof item === "string" && item.trim()) out.push(item.trim());
      if (out.length >= MAX_QUERIES) break;
    }
    return out;
  }

  private async researchQuery(query: string): Promise<string> {
    const [wikiResult, ddgHits] = await Promise.all([
      this.fetchWikipedia(query),
      this.fetchDuckDuckGo(query),
    ]);

    let section = `## ${query}\n\n`;

    if (wikiResult) {
      section += `### Wikipedia\n${wikiResult}\n\n`;
    }

    if (ddgHits.length > 0) {
      section += "### Web results\n";
      for (const hit of ddgHits) {
        section += `- **${hit.title}**: ${hit.snippet}`;
        if (hit.url) section += `\n  <!-- ${hit.url} -->`;
        section += "\n";
      }
      section += "\n";

      const fetchable = ddgHits.filter((h) => h.url).slice(0, 2);
      if (fetchable.length > 0) {
        const pages = await Promise.all(fetchable.map((h) => this.fetchPage(h.url, h.title)));
        const validPages = pages.filter(Boolean);
        if (validPages.length > 0) {
          section += "### Page extracts\n";
          for (const p of validPages) section += p + "\n\n";
        }
      }
    }

    if (!wikiResult && ddgHits.length === 0) {
      section += "No results found for this query.\n";
    }

    return section;
  }

  private async fetchWikipedia(query: string): Promise<string | null> {
    try {
      const searchUrl =
        `https://en.wikipedia.org/w/api.php?action=query&list=search` +
        `&srsearch=${encodeURIComponent(query)}&srlimit=1&format=json&origin=*`;
      const searchRes = await this.timedRequest(searchUrl);
      const searchData: unknown = searchRes.json;
      const queryObj = getRecordProp(searchData, "query");
      const results = asArray(getRecordProp(queryObj, "search")) ?? [];
      if (results.length === 0) return null;

      const title = getStringProp(results[0], "title");
      if (!title) return null;

      const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`;
      const summaryRes = await this.timedRequest(summaryUrl);
      const summaryData: unknown = summaryRes.json;
      const extract = getStringProp(summaryData, "extract");
      if (!extract) return null;

      const contentUrls = getRecordProp(summaryData, "content_urls");
      const desktop = getRecordProp(contentUrls, "desktop");
      const pageUrl = getStringProp(desktop, "page");

      let out = `**${title}:** ${extract}`;
      if (pageUrl) out += `\n<!-- ${pageUrl} -->`;
      return out;
    } catch {
      return null;
    }
  }

  private async fetchDuckDuckGo(query: string): Promise<SearchHit[]> {
    try {
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
      const res = await this.timedRequest(url);
      const data: unknown = res.json;
      const hits: SearchHit[] = [];

      const abstract = getStringProp(data, "Abstract");
      if (abstract && abstract.trim()) {
        hits.push({
          title: getStringProp(data, "AbstractSource") ?? "DuckDuckGo",
          url: getStringProp(data, "AbstractURL") ?? "",
          snippet: abstract,
        });
      }

      const answer = getStringProp(data, "Answer");
      if (answer && answer.trim()) {
        hits.push({
          title: "Direct answer",
          url: "",
          snippet: answer,
        });
      }

      const relatedTopics = asArray(getRecordProp(data, "RelatedTopics")) ?? [];
      for (const topic of relatedTopics.slice(0, 3)) {
        const text = getStringProp(topic, "Text");
        const firstUrl = getStringProp(topic, "FirstURL");
        if (text && text.trim()) {
          hits.push({
            title: text.split(" - ")[0]?.trim().substring(0, 60) ?? "Related",
            url: firstUrl ?? "",
            snippet: text,
          });
        }
      }

      return hits.slice(0, 5);
    } catch {
      return [];
    }
  }

  private async fetchPage(url: string, title: string): Promise<string | null> {
    if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) return null;
    try {
      const res = await this.timedRequest(url);
      if (res.status !== 200) return null;

      const parser = new DOMParser();
      const doc = parser.parseFromString(res.text, "text/html");
      doc
        .querySelectorAll("script, style, noscript, iframe, nav, footer, header, aside, head, .advertisement, .comments")
        .forEach((el) => el.remove());

      const root =
        doc.querySelector("article") ??
        doc.querySelector("main") ??
        doc.querySelector("#content") ??
        doc;

      const lines: string[] = [];
      root.querySelectorAll("h1, h2, h3, p").forEach((el) => {
        const text = el.textContent?.trim();
        if (text && text.length > 15) {
          lines.push(el.tagName.startsWith("H") ? `**${text}**` : text);
        }
      });

      let content = lines.join("\n\n").trim();
      if (!content) return null;
      if (content.length > MAX_PAGE_CHARS) content = content.substring(0, MAX_PAGE_CHARS) + "...";

      return `**${title}** (${url}):\n${content}`;
    } catch {
      return null;
    }
  }

  private async timedRequest(url: string) {
    return Promise.race([
      requestUrl({ url }),
      new Promise<never>((_, reject) =>
        window.setTimeout(() => reject(new Error("Timeout")), REQUEST_TIMEOUT),
      ),
    ]);
  }
}
