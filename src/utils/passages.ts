/** Text helpers for web research, free of Obsidian imports so they can be unit-tested. */

/** DuckDuckGo wraps results as //duckduckgo.com/l/?uddg=<url>. */
export function decodeDuckDuckGoLink(href: string): string {
  const m = /[?&]uddg=([^&]+)/.exec(href);
  const raw = m ? decodeURIComponent(m[1]) : href.startsWith("//") ? `https:${href}` : href;
  return /^https?:\/\//.test(raw) ? raw : "";
}

/**
 * Splits text into passages of about `size` characters on line breaks,
 * each prefixed with the section heading it sits under.
 */
const END_SECTIONS =
  /^(see also|references|notes|external links|further reading|bibliography|sources|citations|footnotes|véase también|referencias|notas|enlaces externos|bibliografía|voir aussi|références|liens externes|siehe auch|einzelnachweise|weblinks)$/i;

export function splitPassages(text: string, size = 700): string[] {
  const out: string[] = [];
  let heading = "";
  let buf = "";
  const flush = () => {
    const t = buf.trim();
    // Link lists at the end of an article are not content.
    if (END_SECTIONS.test(heading)) {
      buf = "";
      return;
    }
    // Short sections still count: "He died in 1142." can be the answer.
    if (t.length >= 12) out.push(heading ? `(${heading}) ${t}` : t);
    buf = "";
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const h = /^(?:##\s+|==+\s*)(.+?)(?:\s*==+)?$/.exec(line);
    if (h) {
      flush();
      heading = h[1].trim();
      continue;
    }
    if (buf.length + line.length > size && buf) flush();
    if (line.length > size * 1.5) {
      // One very long paragraph: cut at sentence ends.
      for (const piece of line.match(new RegExp(`.{1,${size}}(?:[.!?](?=\\s)|$)`, "g")) ?? [line]) {
        buf += piece + " ";
        if (buf.length >= size) flush();
      }
      continue;
    }
    buf += line + "\n";
  }
  flush();
  return out;
}

/** Runs tasks with at most `limit` in flight. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * The note path of a Vault Brain passage labelled "[From <path> (<heading>)]:".
 * Read up to the file extension: a name such as "Napalm Girl (historia de una
 * foto).md" holds brackets of its own, and a lazy match stopped at them.
 */
export function passageNotePath(passage: string): string {
  const m = /^\[From (.+?\.(?:md|pdf))(?: \(.*\))?\]:/.exec(passage);
  return m ? m[1] : "";
}
