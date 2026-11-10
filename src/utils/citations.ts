/**
 * Citations and source pills. The [n] numbers in an answer link to the source
 * they name, and the pills under the answer carry the same numbers with a
 * readable name ("Wikipedia: Peter Abelard"), so each number can be found.
 */

export interface CitedSource {
  n: number;
  title: string;
  url: string;
}

/** A pill under an answer. `n` is set for numbered research sources. */
export interface SourcePill {
  url: string;
  label: string;
  n?: number;
}

/** Reads the "## Sources" list of a Deep Research result: "[n] Title — URL" per line. */
export function parseResearchSources(text: string): Map<number, CitedSource> {
  const out = new Map<number, CitedSource>();
  const at = text.search(/^#{1,3}\s*Sources\s*$/m);
  if (at < 0) return out;
  for (const line of text.slice(at).split("\n")) {
    const m = /^\s*\[(\d+)\]\s+(.+?)\s+[—–-]\s+(https?:\/\/\S+)\s*$/.exec(line);
    if (m) out.set(Number(m[1]), { n: Number(m[1]), title: m[2].trim(), url: m[3] });
  }
  return out;
}

function markdownUrl(url: string): string {
  return url.replace(/\s/g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/** "2", "2, 4", "2-4", "2–4; 7" → [2, 4] / [2, 3, 4] / … ; null when it is not a citation. */
function citationNumbers(inner: string): number[] | null {
  if (!/^\d+(?:\s*[,;–-]\s*\d+)*$/.test(inner)) return null;
  const nums: number[] = [];
  for (const part of inner.split(/\s*[,;]\s*/)) {
    const range = /^(\d+)\s*[–-]\s*(\d+)$/.exec(part);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (b < a || b - a > 20) return null;
      for (let n = a; n <= b; n++) nums.push(n);
    } else {
      nums.push(Number(part));
    }
  }
  return nums;
}

/**
 * Turns every [n] that names a known source into a link to it. The sources
 * themselves are listed by the pills under the answer, not in the text.
 * Code, existing links ("[2](…)"), wikilinks ("[[2]]") and numbers with no
 * source are left as they are. Running it twice changes nothing.
 */
export function linkCitations(answer: string, sources: Map<number, CitedSource>): string {
  if (!sources.size || !answer.trim()) return answer;
  // Odd pieces are code (fenced blocks or inline spans) and stay untouched.
  const pieces = answer.split(/(```[\s\S]*?```|`[^`\n]*`)/);
  for (let i = 0; i < pieces.length; i += 2) {
    pieces[i] = pieces[i].replace(
      /\[([^\]\n]{1,40})\]/g,
      (whole, inner: string, offset: number, str: string) => {
        const before = str[offset - 1];
        const after = str[offset + whole.length];
        if (
          before === "[" ||
          before === "\\" ||
          before === "!" ||
          after === "(" ||
          after === "]" ||
          after === "["
        )
          return whole;
        const nums = citationNumbers(inner.trim());
        if (!nums) return whole;
        const urls: string[] = [];
        for (const n of nums) {
          const source = sources.get(n);
          if (!source) return whole;
          urls.push(source.url);
        }
        return nums.map((n, k) => `[\\[${n}\\]](${markdownUrl(urls[k])})`).join("");
      },
    );
  }
  return pieces.join("");
}

function titleFromPath(segment: string): string {
  let t = segment;
  try {
    t = decodeURIComponent(segment);
  } catch {
    // Keep it as written.
  }
  return t.replace(/_/g, " ").trim();
}

/**
 * A readable name for a source: "Wikipedia: Peter Abelard", "Wikipedia (es):
 * Pedro Abelardo", "Britannica: Peter Abelard", or "site.com: Page title".
 */
export function sourceLabel(url: string, title?: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return title?.trim() || url;
  }
  const host = u.hostname.replace(/^www\./, "").replace(/^m\./, "");
  const wiki = /^([a-z-]{2,12})\.(?:m\.)?(wikipedia|wiktionary)\.org$/.exec(u.hostname);
  if (wiki) {
    const site = wiki[2] === "wikipedia" ? "Wikipedia" : "Wiktionary";
    const lang = wiki[1] === "en" ? "" : ` (${wiki[1]})`;
    const page = /^\/wiki\/(.+)$/.exec(u.pathname);
    const name = page ? titleFromPath(page[1]) : title?.trim() ?? "";
    return name ? `${site}${lang}: ${name}` : `${site}${lang}`;
  }
  if (host === "britannica.com") {
    const last = u.pathname.split("/").filter(Boolean).pop();
    const name = title?.trim() || (last ? titleFromPath(last).replace(/-/g, " ") : "");
    return name ? `Britannica: ${name}` : "Britannica";
  }
  const clean = title
    ?.replace(/\s+/g, " ")
    .replace(/\s+[|·–—-]\s+[^|·–—-]{1,40}$/, "") // drop a trailing " | Site name"
    .trim();
  return clean && clean !== url ? `${host}: ${clean}` : host;
}

/** Trims Markdown and punctuation stuck to the end of an address, keeping balanced brackets. */
function cleanUrl(raw: string): string {
  const strip = (u: string) => u.replace(/[\].,;:!?*'"]+$/g, "");
  let url = strip(raw.trim());
  const count = (u: string, ch: string) => u.split(ch).length - 1;
  while (url.endsWith(")") && count(url, "(") < count(url, ")")) url = strip(url.slice(0, -1));
  return url;
}

/**
 * The pills for one skill result. A Deep Research result gives its numbered
 * sources, in order; any other result gives the links in it, named from the
 * link text when there is one.
 */
export function pillsFromSkillResult(result: string): SourcePill[] {
  const research = parseResearchSources(result);
  if (research.size) {
    return [...research.values()]
      .sort((a, b) => a.n - b.n)
      .map((s) => ({ url: s.url, n: s.n, label: sourceLabel(s.url, s.title) }));
  }
  const titles = new Map<string, string>();
  const order: string[] = [];
  const add = (raw: string, title?: string) => {
    const url = cleanUrl(raw);
    if (!/^https?:\/\//i.test(url)) return;
    if (!titles.has(url)) {
      titles.set(url, title ?? "");
      order.push(url);
    } else if (title && !titles.get(url)) {
      titles.set(url, title);
    }
  };
  // Addresses may hold balanced brackets: /wiki/Mercury_(planet).
  const md = /\[([^\]]+)\]\((https?:\/\/(?:[^()\s]|\([^()\s]*\))+)\)/gi;
  let m: RegExpExecArray | null;
  while ((m = md.exec(result)) !== null) add(m[2], m[1].replace(/[*_`]/g, ""));
  const raw = /(https?:\/\/[^\s<>"']+)/gi;
  while ((m = raw.exec(result)) !== null) add(m[1]);
  return order.map((url) => ({ url, label: sourceLabel(url, titles.get(url) || undefined) }));
}

/**
 * Adds pills, one per address. A numbered pill replaces an unnumbered one for
 * the same address; numbered pills come first, in number order.
 */
export function mergePills(into: SourcePill[], add: SourcePill[]): SourcePill[] {
  // A newer research result renumbers the sources (the answer cites the newest
  // numbering), so earlier numbers are dropped rather than shown twice.
  if (add.some((p) => p.n !== undefined)) {
    for (let i = 0; i < into.length; i++)
      if (into[i].n !== undefined) into[i] = { url: into[i].url, label: into[i].label };
  }
  for (const p of add) {
    const i = into.findIndex((q) => q.url === p.url);
    if (i < 0) into.push(p);
    else if (p.n !== undefined && into[i].n === undefined) into[i] = p;
  }
  const numbered = into.filter((p) => p.n !== undefined).sort((a, b) => (a.n ?? 0) - (b.n ?? 0));
  const rest = into.filter((p) => p.n === undefined);
  into.splice(0, into.length, ...numbered, ...rest);
  return into;
}
