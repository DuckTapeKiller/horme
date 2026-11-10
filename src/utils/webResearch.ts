import { RequestUrlResponse } from "obsidian";
import { requestUrlWithTimeout } from "./requestWithTimeout";
import { isPublicHttpUrl } from "./urlSafety";
import { asArray, getRecordProp, getStringProp } from "./TypeGuards";
import { decodeDuckDuckGoLink } from "./passages";
export { decodeDuckDuckGoLink, splitPassages, mapLimit } from "./passages";

/**
 * Web lookups that work without an API key: DuckDuckGo's HTML results page,
 * Wikipedia's full-text search, full articles and category member lists, and a
 * readable-text extractor for ordinary pages that keeps lists and tables.
 */

export interface WebHit {
  title: string;
  url: string;
  snippet: string;
}

export interface PageText {
  title: string;
  url: string;
  text: string;
}

/** Wikimedia asks automated clients to identify themselves. */
export const WIKIMEDIA_HEADERS = {
  "User-Agent": "Horme (Obsidian plugin; https://github.com/DuckTapeKiller/horme)",
};

const TIMEOUT = 12000;
const MAX_PAGE_CHARS = 40000;

async function get(url: string, headers?: Record<string, string>): Promise<RequestUrlResponse> {
  return requestUrlWithTimeout({ url, headers, throw: false }, TIMEOUT);
}

function wikiHost(lang: string): string {
  const code = /^[a-z-]{2,12}$/.test(lang) ? lang : "en";
  return `https://${code}.wikipedia.org`;
}

/**
 * Web search through DuckDuckGo's HTML page (no key), falling back to its lite
 * page, which answers when the first is briefly rate-limited. Empty when both
 * are blocked or find nothing.
 */
export async function searchWeb(query: string, max = 8): Promise<WebHit[]> {
  const q = encodeURIComponent(query);
  const html = await get(`https://html.duckduckgo.com/html/?q=${q}`).catch(() => null);
  const hits = html && html.status === 200 ? parseDuckDuckGo(html.text, "html", max) : [];
  if (hits.length) return hits;
  const lite = await get(`https://lite.duckduckgo.com/lite/?q=${q}`).catch(() => null);
  return lite && lite.status === 200 ? parseDuckDuckGo(lite.text, "lite", max) : [];
}

function parseDuckDuckGo(body: string, kind: "html" | "lite", max: number): WebHit[] {
  const doc = new DOMParser().parseFromString(body, "text/html");
  const hits: WebHit[] = [];
  const anchors = Array.from(
    doc.querySelectorAll<HTMLAnchorElement>(kind === "html" ? "a.result__a" : "a.result-link"),
  );
  for (const a of anchors) {
    const url = decodeDuckDuckGoLink(a.getAttribute("href") ?? "");
    if (!url || /duckduckgo\.com\/y\.js/.test(url)) continue; // ads
    let snippet = "";
    if (kind === "html") {
      snippet = a.closest(".result")?.querySelector(".result__snippet")?.textContent?.trim() ?? "";
    } else {
      // Lite: the snippet is in the next table row.
      snippet =
        a.closest("tr")?.nextElementSibling?.querySelector(".result-snippet")?.textContent?.trim() ?? "";
    }
    hits.push({ title: a.textContent?.trim() || url, url, snippet });
    if (hits.length >= max) break;
  }
  return hits;
}

/** Full-text Wikipedia search over articles and categories (categories hold the "lists"). */
export async function searchWikipedia(query: string, max = 5, lang = "en"): Promise<WebHit[]> {
  const url =
    `${wikiHost(lang)}/w/api.php?action=query&list=search&srwhat=text&srnamespace=0|14` +
    `&srlimit=${max}&format=json&srsearch=${encodeURIComponent(query)}`;
  const res = await get(url, WIKIMEDIA_HEADERS);
  if (res.status !== 200) return [];
  const results = asArray(getRecordProp(getRecordProp(safeJson(res), "query"), "search")) ?? [];
  const hits: WebHit[] = [];
  for (const r of results) {
    const title = getStringProp(r, "title");
    if (!title) continue;
    hits.push({
      title,
      url: `${wikiHost(lang)}/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
      snippet: (getStringProp(r, "snippet") ?? "").replace(/<[^>]+>/g, ""),
    });
  }
  return hits;
}

function safeJson(res: RequestUrlResponse): unknown {
  try {
    return res.json as unknown;
  } catch {
    return null;
  }
}

/** A Wikipedia article as plain text, section headings kept. */
async function fetchWikipediaArticle(title: string, lang: string): Promise<PageText | null> {
  // The page as HTML first: the plain-text extract leaves out every table, so a
  // "List of …" article came through as its two-line introduction.
  const pageUrl = (t: string) => `${wikiHost(lang)}/wiki/${encodeURIComponent(t.replace(/ /g, "_"))}`;
  const rest = await get(
    `${wikiHost(lang)}/api/rest_v1/page/html/${encodeURIComponent(title.replace(/ /g, "_"))}`,
    WIKIMEDIA_HEADERS,
  ).catch(() => null);
  if (rest && rest.status === 200) {
    const page = htmlToText(rest.text, pageUrl(title));
    if (page) {
      const realTitle = page.title && !/^https?:/.test(page.title) ? page.title : title;
      return { title: realTitle, url: pageUrl(realTitle), text: page.text };
    }
  }

  const url =
    `${wikiHost(lang)}/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json` +
    `&titles=${encodeURIComponent(title)}`;
  const res = await get(url, WIKIMEDIA_HEADERS);
  if (res.status !== 200) return null;
  const pages = getRecordProp(getRecordProp(safeJson(res), "query"), "pages");
  if (!pages || typeof pages !== "object") return null;
  for (const page of Object.values(pages as Record<string, unknown>)) {
    const text = getStringProp(page, "extract");
    const realTitle = getStringProp(page, "title") ?? title;
    if (text && text.trim()) {
      return { title: realTitle, url: pageUrl(realTitle), text: text.slice(0, MAX_PAGE_CHARS) };
    }
  }
  return null;
}

/** The members of a Wikipedia category, as a plain list. */
async function fetchWikipediaCategory(title: string, lang: string): Promise<PageText | null> {
  const url =
    `${wikiHost(lang)}/w/api.php?action=query&list=categorymembers&cmlimit=300&cmnamespace=0|14&format=json` +
    `&cmtitle=${encodeURIComponent(title)}`;
  const res = await get(url, WIKIMEDIA_HEADERS);
  if (res.status !== 200) return null;
  const members = asArray(getRecordProp(getRecordProp(safeJson(res), "query"), "categorymembers")) ?? [];
  const names = members.map((m) => getStringProp(m, "title")).filter((t): t is string => !!t);
  if (!names.length) return null;
  const name = title.replace(/^[^:]+:/, "");
  return {
    title,
    url: `${wikiHost(lang)}/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
    text: `Wikipedia lists these ${names.length} pages in the category "${name}":\n${names.map((n) => `- ${n}`).join("\n")}`,
  };
}

/** Parses a Wikipedia page URL into its language and title. */
function parseWikipediaUrl(url: string): { lang: string; title: string } | null {
  const m = /^https?:\/\/([a-z-]{2,12})(?:\.m)?\.wikipedia\.org\/wiki\/([^?#]+)/.exec(url);
  if (!m) return null;
  try {
    return { lang: m[1], title: decodeURIComponent(m[2]).replace(/_/g, " ") };
  } catch {
    return null;
  }
}

/**
 * Readable text of a public page: headings, paragraphs, list items and table
 * rows (lists and tables are where "who/which" answers usually are).
 * Wikipedia pages come through its API instead of the HTML.
 */
export async function fetchPageText(url: string): Promise<PageText | null> {
  if (!isPublicHttpUrl(url)) return null;
  const wiki = parseWikipediaUrl(url);
  if (wiki) {
    return /^(Category|Categoría|Catégorie|Kategorie|Categoria):/i.test(wiki.title)
      ? fetchWikipediaCategory(wiki.title, wiki.lang)
      : fetchWikipediaArticle(wiki.title, wiki.lang);
  }
  const res = await get(url);
  if (res.status < 200 || res.status >= 300) return null;
  const type = (res.headers["content-type"] ?? res.headers["Content-Type"] ?? "").toLowerCase();
  if (type && !type.includes("html") && !type.includes("text")) return null;
  return htmlToText(res.text, url);
}

/** A table's column names: its first row when every cell is a header cell. */
const headerCache = new WeakMap<Element, { row: Element; names: string[] } | null>();
function tableHeaders(row: Element): { row: Element; names: string[] } | null {
  const table = row.closest("table");
  if (!table) return null;
  if (headerCache.has(table)) return headerCache.get(table) ?? null;
  let found: { row: Element; names: string[] } | null = null;
  const first = table.querySelector("tr");
  if (first) {
    const cells = Array.from(first.children).filter((c) => c.tagName === "TH" || c.tagName === "TD");
    if (cells.length > 1 && cells.every((c) => c.tagName === "TH")) {
      found = { row: first, names: cells.map((c) => c.textContent?.replace(/\s+/g, " ").trim() ?? "") };
    }
  }
  headerCache.set(table, found);
  return found;
}

export function htmlToText(html: string, url: string): PageText | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const title = doc.querySelector("title")?.textContent?.trim() || url;
  doc
    .querySelectorAll(
      "script, style, noscript, iframe, svg, form, nav, footer, header, aside, " +
        "[role=navigation], [role=banner], [role=contentinfo], .advertisement, .ad, .ads, .comments, .cookie, " +
        // Wikipedia: footnote marks, reference lists, navigation boxes, edit links.
        "sup.reference, .mw-references-wrap, ol.references, .reflist, .navbox, .mw-editsection, .noprint, .mw-empty-elt",
    )
    .forEach((el) => el.remove());
  // Any page's footnote marks ("[3]", "12"): the answer's own [n] numbers are the sources.
  doc.querySelectorAll("sup").forEach((el) => {
    if (/^\s*\[?\s*(?:\d+|[a-z])\s*\]?\s*$/i.test(el.textContent ?? "")) el.remove();
  });
  const root =
    doc.querySelector("article") ?? doc.querySelector("main") ?? doc.querySelector("#content") ?? doc.body;
  if (!root) return null;
  const lines: string[] = [];
  root.querySelectorAll("h1, h2, h3, h4, p, li, tr, blockquote, dt, dd").forEach((el) => {
    // A list item or cell that holds a nested list or table is read through its children.
    if ((el.tagName === "LI" || el.tagName === "BLOCKQUOTE") && el.querySelector("p, li, tr")) return;
    let text: string;
    if (el.tagName === "TR") {
      const cells = Array.from(el.querySelectorAll("th, td")).map(
        (c) => c.textContent?.replace(/\s+/g, " ").trim() ?? "",
      );
      const headers = tableHeaders(el);
      if (headers && el === headers.row) return; // the header row is written into each row below
      // "Item: …; Price: …" makes every row readable on its own, once passages are cut.
      text =
        headers && headers.names.length === cells.length
          ? cells
              .map((c, i) => (c && headers.names[i] ? `${headers.names[i]}: ${c}` : c))
              .filter(Boolean)
              .join("; ")
          : cells.filter(Boolean).join(" | ");
    } else {
      text = el.textContent?.replace(/\s+/g, " ").trim() ?? "";
    }
    if (text.length < 3) return;
    if (/^H\d$/.test(el.tagName)) lines.push(`\n## ${text}`);
    else if (el.tagName === "LI" || el.tagName === "TR") lines.push(`- ${text}`);
    else lines.push(text);
  });
  const text = lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length < 200) return null;
  return { title, url, text: text.slice(0, MAX_PAGE_CHARS) };
}
