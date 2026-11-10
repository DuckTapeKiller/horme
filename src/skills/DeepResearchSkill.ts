import type HormePlugin from "../../main";
import { Skill, SkillParameter } from "./types";
import { errorToMessage, getStringProp, isRecord } from "../utils/TypeGuards";
import { cosineSimilarity, getModelPrefixes } from "../utils/VectorUtils";
import {
  PageText,
  WebHit,
  fetchPageText,
  mapLimit,
  searchWeb,
  searchWikipedia,
  splitPassages,
} from "../utils/webResearch";

const MAX_QUERIES = 6;
const MAX_PAGES = 12;
const PAGE_CONCURRENCY = 4;
const OVERALL_DEADLINE_MS = 60000;
const MAX_PASSAGES_TO_EMBED = 240;
const MAX_PASSAGES_PER_SOURCE = 4;

const STOPWORDS = new Set(
  (
    "the and for are was were who whom whose which what when where why how that this these those with from " +
    "have has had been being into about than then them they their there his her its our your you not but " +
    "all any can could would should may might will shall did does doing done also some such more most other " +
    "use using used example examples e.g eg list famous people person known"
  ).split(" "),
);

interface Candidate extends WebHit {
  score: number;
}

interface Passage {
  source: number;
  text: string;
  score: number;
}

/**
 * Deep research run by code, not by the model: the model only supplies the
 * question (and, if it can, a few queries). The skill widens the queries,
 * searches Wikipedia (articles and categories) and the web, reads the best
 * pages in full, keeps the passages closest to the question (embeddings when
 * an embedding server is set up, keyword overlap otherwise) and returns them
 * numbered, with their sources, sized for the model's context.
 */
export class DeepResearchSkill implements Skill {
  id = "deep_research";
  name = "Deep Research";
  description =
    "Researches a question across Wikipedia (articles and category lists) and the web, reads the best pages in full and returns the most relevant passages with numbered sources. Use for questions that need several sources, lists of examples, or facts you are unsure of.";
  terminal = false;
  primaryParam = "question";
  parameters: SkillParameter[] = [
    {
      name: "question",
      type: "string",
      description: "The user's full question, in their words.",
      required: true,
    },
    {
      name: "queries",
      type: "array",
      items: { type: "string" },
      description:
        "Optional: up to five short search queries that approach the question from different angles.",
      required: false,
    },
  ];
  instructions =
    'To use this skill, output exactly: <call:deep_research>{"question": "the user\'s full question", "queries": ["short query", "another angle"]}</call>. ' +
    "Use it when the answer needs several sources, a list of examples, or facts you are not sure of. " +
    "When the results come back, answer only from the passages, cite each fact with its source number like [2], and say what the passages do not cover.";

  constructor(private plugin?: HormePlugin) {}

  async execute(params: unknown): Promise<string> {
    try {
      const given = this.parseQueries(isRecord(params) ? params.queries : undefined);
      const question = (getStringProp(params, "question") ?? "").trim() || given.join("; ");
      if (!question) return 'Invalid parameters: expected {"question": "...", "queries": ["..."]}';
      const deadline = Date.now() + OVERALL_DEADLINE_MS;

      const queries = await this.buildQueries(question, given);
      const candidates = await this.search(queries);
      if (!candidates.length) {
        return `# Research results\n\nNo search results came back for: ${queries.join("; ")}. The search services may be unreachable. Answer from what you know and say that it could not be checked.`;
      }

      const pages = await this.readPages(candidates, deadline);
      if (!pages.length) {
        return this.snippetsOnly(question, candidates);
      }

      const passages = await this.rankPassages(question, queries, pages);
      return this.format(question, queries, pages, passages);
    } catch (e: unknown) {
      console.error("Horme Deep Research Skill Error:", e);
      return `Error: Deep research failed. ${errorToMessage(e)}`;
    }
  }

  private parseQueries(raw: unknown): string[] {
    const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
    const out: string[] = [];
    for (const item of list) {
      if (typeof item === "string" && item.trim()) out.push(item.trim().slice(0, 200));
      if (out.length >= MAX_QUERIES) break;
    }
    return out;
  }

  /** The question, the model's queries, and (when few were given) a handful more from the model. */
  private async buildQueries(question: string, given: string[]): Promise<string[]> {
    const queries = [question.slice(0, 200), ...given];
    if (given.length < 3 && this.plugin) {
      try {
        const reply = await Promise.race([
          this.plugin.aiGateway.generate(
            `Question: ${question}\n\nWrite 4 short web search queries (3 to 8 words each) that together would find the facts needed to answer it. Include one that would find a list, category or overview page if the question asks for examples. Reply with the queries only, one per line, no numbering.`,
            "You write search queries. Output only the queries, one per line.",
            undefined,
            true,
          ),
          new Promise<string>((resolve) => window.setTimeout(() => resolve(""), 30000)),
        ]);
        for (const line of reply.split("\n")) {
          const q = line
            .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "")
            .replace(/^["']|["']$/g, "")
            .trim();
          if (q.length >= 3 && q.length <= 120 && !/[:]$/.test(q)) queries.push(q);
        }
      } catch {
        // The searches still run on the question and the given queries.
      }
    }
    const seen = new Set<string>();
    return queries
      .filter((q) => {
        const k = q.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, MAX_QUERIES);
  }

  /** Wikipedia for every query, the web for the first four; pages found by several searches rank first. */
  private async search(queries: string[]): Promise<Candidate[]> {
    const wiki = Promise.all(queries.map((q) => searchWikipedia(q, 5).catch((): WebHit[] => [])));
    // DuckDuckGo turns away bursts, so its searches run one after another.
    const web = (async () => {
      const lists: WebHit[][] = [];
      for (const q of queries.slice(0, 4)) lists.push(await searchWeb(q, 8).catch((): WebHit[] => []));
      return lists;
    })();
    const lists = [...(await wiki), ...(await web)];
    const byUrl = new Map<string, Candidate>();
    for (const hits of lists) {
      hits.forEach((hit, rank) => {
        const key = hit.url
          .replace(/^https?:\/\/(?:www\.)?/, "")
          .replace(/#.*$/, "")
          .replace(/\/$/, "");
        const gain = 1 / (rank + 1) + 0.5;
        const existing = byUrl.get(key);
        if (existing) existing.score += gain;
        else byUrl.set(key, { ...hit, score: gain + (/\/wiki\/Category:/.test(hit.url) ? 0.6 : 0) });
      });
    }
    return Array.from(byUrl.values()).sort((a, b) => b.score - a.score);
  }

  private async readPages(candidates: Candidate[], deadline: number): Promise<PageText[]> {
    const picked = candidates.slice(0, MAX_PAGES + 4);
    const pages = await mapLimit(picked, PAGE_CONCURRENCY, async (c) => {
      if (Date.now() > deadline) return null;
      try {
        const page = await fetchPageText(c.url);
        if (page && c.title && page.title === page.url) page.title = c.title;
        return page;
      } catch {
        return null;
      }
    });
    // The same article under two addresses (www, mobile, AMP) is read once.
    const seen = new Set<string>();
    return pages
      .filter((p): p is PageText => !!p)
      .filter((p) => {
        const key = p.text.replace(/\s+/g, " ").slice(0, 400).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, MAX_PAGES);
  }

  /** Keyword overlap first (cheap), then embeddings on the best few hundred when an embedding server answers. */
  private async rankPassages(question: string, queries: string[], pages: PageText[]): Promise<Passage[]> {
    const all: Passage[] = [];
    pages.forEach((page, source) => {
      // A category's member list is one passage: split, most names were lost.
      if (/\/wiki\/Category(?:%3A|:)/.test(page.url)) {
        all.push({ source, text: page.text.slice(0, 3000), score: 0 });
        return;
      }
      for (const text of splitPassages(page.text)) all.push({ source, text, score: 0 });
    });

    const terms = this.terms(`${question} ${queries.join(" ")}`);
    const df = new Map<string, number>();
    // Each passage is ranked with its page title: a row of "List of most
    // expensive philatelic items" rarely repeats the question's words itself.
    const withTitle = (p: Passage) => `${pages[p.source].title} — ${p.text}`;
    const tokenSets = all.map((p) => new Set(this.terms(withTitle(p))));
    for (const set of tokenSets) for (const t of set) df.set(t, (df.get(t) ?? 0) + 1);
    all.forEach((p, i) => {
      let s = 0;
      for (const t of new Set(terms))
        if (tokenSets[i].has(t)) s += Math.log(1 + all.length / (df.get(t) ?? 1));
      p.score = s / Math.sqrt(1 + tokenSets[i].size / 40);
    });
    let pool = all.sort((a, b) => b.score - a.score).slice(0, MAX_PASSAGES_TO_EMBED);

    if (this.plugin) {
      try {
        const service = this.plugin.embeddingService;
        const prefixes = getModelPrefixes(service.embeddingModelName());
        const vectors = await service.getEmbeddings([
          prefixes.query + question,
          ...pool.map((p) => prefixes.doc + withTitle(p)),
        ]);
        if (vectors.length === pool.length + 1 && vectors[0]?.length) {
          const maxLex = Math.max(...pool.map((p) => p.score), 1e-9);
          pool = pool.map((p, i) => ({
            ...p,
            // Meaning first, with a little keyword weight so names in the question count.
            score: cosineSimilarity(vectors[0], vectors[i + 1]) + 0.15 * (p.score / maxLex),
          }));
        }
      } catch {
        // No embedding server: keyword ranking stands.
      }
    }
    return pool.sort((a, b) => b.score - a.score);
  }

  private terms(text: string): string[] {
    return (
      text
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .match(/[a-z0-9]{3,}/g) ?? []
    ).filter((t) => !STOPWORDS.has(t));
  }

  /** Room for the passages: small for local models, larger for cloud ones. */
  private budget(): number {
    return this.plugin && !this.plugin.isLocalProviderActive() ? 24000 : 10000;
  }

  private format(question: string, queries: string[], pages: PageText[], ranked: Passage[]): string {
    const budget = this.budget();
    const perSource = new Map<number, number>();
    const chosen: Passage[] = [];
    let used = 0;
    const seenText = new Set<string>();
    for (const p of ranked) {
      const key = p.text
        .replace(/^\([^)]*\)\s*/, "")
        .replace(/\s+/g, " ")
        .toLowerCase();
      if (seenText.has(key)) continue;
      const n = perSource.get(p.source) ?? 0;
      if (n >= MAX_PASSAGES_PER_SOURCE) continue;
      if (used + p.text.length > budget) continue;
      chosen.push(p);
      seenText.add(key);
      perSource.set(p.source, n + 1);
      used += p.text.length;
    }
    // Number the sources in the order they are first used.
    const number = new Map<number, number>();
    for (const p of chosen) if (!number.has(p.source)) number.set(p.source, number.size + 1);

    let out = `# Research results\n\n**Question:** ${question}\n**Searched:** ${queries.join(" · ")}\n\n`;
    out +=
      "Answer the question from these passages only. Cite every fact with its source number, like [2]. " +
      "If the passages do not answer part of the question, say so plainly instead of guessing.\n\n## Passages\n\n";
    for (const p of chosen) out += `[${number.get(p.source)}] ${p.text.replace(/\n+/g, " ")}\n\n`;
    out += "## Sources\n\n";
    for (const [source, n] of Array.from(number.entries()).sort((a, b) => a[1] - b[1])) {
      out += `[${n}] ${pages[source].title} — ${pages[source].url}\n`;
    }
    return out.trim();
  }

  private snippetsOnly(question: string, candidates: Candidate[]): string {
    let out = `# Research results\n\n**Question:** ${question}\n\nNo page could be read in full; these are the search snippets. Cite them by number and say the pages were not read.\n\n`;
    candidates.slice(0, 12).forEach((c, i) => {
      out += `[${i + 1}] ${c.title}: ${c.snippet}\n    ${c.url}\n`;
    });
    return out.trim();
  }
}
