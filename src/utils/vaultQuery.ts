/**
 * Questions about the vault itself (how many notes, which ones, by topic,
 * folder, tag, property or date), answered from Obsidian's own file list and
 * metadata, so counts are exact. Vault Brain cannot answer them: it only sees
 * the dozen passages closest to the question.
 *
 * Pure functions over plain note records; VaultQuerySkill gathers the records.
 */

export interface NoteInfo {
  /** "Folder/Sub/Note.md" */
  path: string;
  /** The file name without ".md". */
  title: string;
  /** "Folder/Sub", or "" at the vault root. */
  folder: string;
  /** Without "#", as written. */
  tags: string[];
  aliases: string[];
  /** Frontmatter properties. */
  properties: Record<string, unknown>;
  created: number;
  modified: number;
}

export interface QueryFilters {
  topic?: string;
  text?: string;
  folder?: string;
  tag?: string;
  property?: string;
  value?: string;
  createdAfter?: number;
  createdBefore?: number;
  modifiedAfter?: number;
  modifiedBefore?: number;
}

export type MatchWay = "title" | "folder" | "tag" | "property";

/** Lower case without accents, so "Sellos", "sellós" and "SELLOS" compare equal. */
export function fold(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

const WORD = /[^\p{L}\p{N}]+/u;

/** The forms a word may take: "stamps" also finds "stamp", "classes" "class", "series" "series". */
function wordForms(word: string): string[] {
  const forms = new Set([word]);
  if (word.length > 3 && word.endsWith("s")) forms.add(word.slice(0, -1));
  if (word.length > 4 && word.endsWith("es")) forms.add(word.slice(0, -2));
  if (word.length > 4 && word.endsWith("ies")) forms.add(word.slice(0, -3) + "y");
  return [...forms];
}

/**
 * Whether a text speaks of a topic: every word of the topic appears as a whole
 * word, singular or plural, in any order. Null for an empty topic.
 */
export function topicMatcher(topic: string): ((text: string) => boolean) | null {
  const words = fold(topic)
    .split(WORD)
    .filter((w) => w.length > 0);
  if (words.length === 0) return null;
  const patterns = words.map((w) => {
    const forms = wordForms(w)
      .sort((a, b) => b.length - a.length)
      .join("|");
    // No lookbehind: Obsidian's iOS build rejects it.
    return new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${forms})(?:s|es)?(?![\\p{L}\\p{N}])`, "u");
  });
  return (text: string) => {
    const t = fold(text);
    return patterns.every((p) => p.test(t));
  };
}

/** Whether a text holds a phrase, ignoring case, accents and spacing. */
export function phraseMatcher(phrase: string): ((text: string) => boolean) | null {
  const p = fold(phrase).replace(/\s+/g, " ").trim();
  if (!p) return null;
  return (text: string) => fold(text).replace(/\s+/g, " ").includes(p);
}

/** The first line of a text that holds the match, shortened around it. */
/**
 * The first line of a note that holds a phrase, without HTML tags, cut to about
 * `max` characters around the phrase so the quote shows it.
 */
export function snippet(content: string, phrase: string, max = 160): string {
  const words = fold(phrase)
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return "";
  const re = new RegExp(words.join("\\s+"));
  for (const raw of content.split("\n")) {
    const line = raw
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const folded = fold(line);
    const m = line ? re.exec(folded) : null;
    if (!m) continue;
    if (line.length <= max) return line;
    // fold() keeps the length of ordinary text, so the match sits at the same place in the line.
    const at = folded.length === line.length ? m.index : 0;
    const start = Math.max(0, Math.min(at - Math.floor((max - m[0].length) / 2), line.length - max));
    const piece = line.slice(start, start + max).trim();
    return `${start > 0 ? "…" : ""}${piece}${start + max < line.length ? "…" : ""}`;
  }
  return "";
}

function valueText(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.flatMap(valueText);
  if (typeof v === "string") return [v];
  if (typeof v === "number" || typeof v === "boolean") return [String(v)];
  return [];
}

/** Whether a folder path is the folder asked for: its full path, or any folder in it by name. */
export function folderMatches(folder: string, wanted: string): boolean {
  const q = fold(wanted)
    .replace(/^\/+|\/+$/g, "")
    .trim();
  if (!q) return true;
  const f = fold(folder);
  if (f === q || f.startsWith(`${q}/`)) return true;
  return f.split("/").some((seg) => seg === q || seg.includes(q));
}

/** Whether a note carries a tag, nested tags included (#stamps/uk is a #stamps note). */
export function tagMatches(tags: string[], wanted: string): boolean {
  const q = fold(wanted.replace(/^#/, "")).trim();
  if (!q) return true;
  const forms = wordForms(q);
  return tags.some((t) => {
    const tag = fold(t.replace(/^#/, ""));
    return forms.some(
      (f) => tag === f || tag === `${f}s` || tag.startsWith(`${f}/`) || tag.startsWith(`${f}s/`),
    );
  });
}

/** Whether a note has a property (any value), or a property holding a value. */
export function propertyMatches(props: Record<string, unknown>, key: string, value?: string): boolean {
  const k = fold(key).trim();
  const entry = Object.entries(props).find(([name]) => fold(name) === k);
  if (!entry) return false;
  const values = valueText(entry[1]).map(fold);
  if (!value?.trim()) return values.some((v) => v.trim().length > 0);
  const want = fold(value).trim();
  return values.some((v) => v === want || v.includes(want));
}

/** The notes that pass every filter except topic and text, which need more work. */
export function applyFilters(notes: NoteInfo[], f: QueryFilters): NoteInfo[] {
  return notes.filter(
    (n) =>
      (!f.folder || folderMatches(n.folder, f.folder)) &&
      (!f.tag || tagMatches(n.tags, f.tag)) &&
      (!f.property || propertyMatches(n.properties, f.property, f.value)) &&
      (f.createdAfter === undefined || n.created >= f.createdAfter) &&
      (f.createdBefore === undefined || n.created < f.createdBefore) &&
      (f.modifiedAfter === undefined || n.modified >= f.modifiedAfter) &&
      (f.modifiedBefore === undefined || n.modified < f.modifiedBefore),
  );
}

/** How a note is about a topic: its title or aliases, a folder, a tag, or a property value. */
export function topicWays(n: NoteInfo, matches: (text: string) => boolean): MatchWay[] {
  const ways: MatchWay[] = [];
  if (matches(n.title) || n.aliases.some(matches)) ways.push("title");
  if (n.folder && n.folder.split("/").some(matches)) ways.push("folder");
  if (n.tags.some((t) => matches(t.replace(/[/_-]/g, " ")))) ways.push("tag");
  // Tags and aliases in the properties are already counted above.
  const own = Object.entries(n.properties).filter(([k]) => !/^(tags?|alias(es)?|cssclass(es)?)$/i.test(k));
  // Only short values (a category, a title, a name): a long excerpt or a web
  // address that mentions the topic does not make the note about it.
  const short = (s: string) => s.length <= 60 && !/^https?:\/\//i.test(s.trim());
  if (own.some(([, v]) => valueText(v).some((s) => short(s) && matches(s)))) ways.push("property");
  return ways;
}

/**
 * A date the model wrote, as the start of that day (or month, or year) in local
 * time: "before 2026-11-12" excludes the 12th, "after 2026-03" starts on 1 March.
 * Accepts YYYY-MM-DD, YYYY-MM and YYYY. Undefined when it cannot be read.
 */
export function parseDay(text: string | undefined): number | undefined {
  const m = /^\s*(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?\s*$/.exec(text ?? "");
  if (!m) return undefined;
  const y = Number(m[1]);
  const mo = m[2] ? Number(m[2]) - 1 : 0;
  const d = m[3] ? Number(m[3]) : 1;
  if (mo < 0 || mo > 11 || d < 1 || d > 31) return undefined;
  return new Date(y, mo, d).getTime();
}

export function isoDay(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** An Obsidian link to a note, shown by its title. */
export function noteLink(n: NoteInfo): string {
  const target = n.path.replace(/\.md$/i, "");
  return target === n.title ? `[[${n.title}]]` : `[[${target}|${n.title}]]`;
}

/** Counts per folder (by its first level), largest first. */
export function countByTopFolder(notes: NoteInfo[], top = 12): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const n of notes) {
    const key = n.folder ? n.folder.split("/")[0] : "(vault root)";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, top);
}

/** Counts per tag, largest first. */
export function countByTag(notes: NoteInfo[], top = 20): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const n of notes)
    for (const t of new Set(n.tags.map((x) => x.replace(/^#/, "")))) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, top);
}

export type SortOrder = "modified" | "created" | "name";

export function sortNotes(notes: NoteInfo[], order: SortOrder): NoteInfo[] {
  const out = [...notes];
  if (order === "name") out.sort((a, b) => a.title.localeCompare(b.title));
  else if (order === "created") out.sort((a, b) => b.created - a.created);
  else out.sort((a, b) => b.modified - a.modified);
  return out;
}

/** Finds the note a name points to: its path, its title, then a title that starts with or holds it. */
export function findNote(notes: NoteInfo[], name: string): { note?: NoteInfo; candidates: NoteInfo[] } {
  const q = fold(
    name
      .replace(/^\[\[|\]\]$/g, "")
      .replace(/\|.*$/, "")
      .replace(/\.md$/i, ""),
  ).trim();
  if (!q) return { candidates: [] };
  const byPath = notes.find((n) => fold(n.path.replace(/\.md$/i, "")) === q);
  if (byPath) return { note: byPath, candidates: [] };
  const exact = notes.filter((n) => fold(n.title) === q || n.aliases.some((a) => fold(a) === q));
  if (exact.length === 1) return { note: exact[0], candidates: [] };
  if (exact.length > 1) return { candidates: exact };
  const starts = notes.filter((n) => fold(n.title).startsWith(q));
  if (starts.length === 1) return { note: starts[0], candidates: [] };
  if (starts.length > 1) return { candidates: starts };
  const holds = notes.filter((n) => fold(n.title).includes(q));
  if (holds.length === 1) return { note: holds[0], candidates: [] };
  return { candidates: holds };
}
