import { TFile, getAllTags, parseFrontMatterAliases } from "obsidian";
import type HormePlugin from "../../main";
import { Skill, SkillParameter } from "./types";
import { getNumberProp, getStringProp } from "../utils/TypeGuards";
import {
  applyFilters,
  countByTag,
  countByTopFolder,
  findNote,
  isoDay,
  noteLink,
  parseDay,
  phraseMatcher,
  snippet,
  sortNotes,
  topicMatcher,
  topicWays,
  type MatchWay,
  type NoteInfo,
  type QueryFilters,
  type SortOrder,
} from "../utils/vaultQuery";

/** Reading every note for a text search stops here; the answer says how far it got. */
const TEXT_SCAN_MS = 20_000;
/** A note read in full is cut here: local models have small context windows. */
const READ_CHARS_LOCAL = 12_000;
const READ_CHARS_CLOUD = 24_000;

const WAY_LABEL: Record<MatchWay, string> = {
  title: "title",
  folder: "folder",
  tag: "tag",
  property: "property",
};

/**
 * Answers questions about the vault itself from Obsidian's own file list and
 * metadata: how many notes, which ones (by topic, folder, tag, property or
 * date), a note in full, and an overview. Counts are exact, unlike Vault Brain,
 * which only sees the passages closest to a question. Works without the vault
 * index, offline and on mobile.
 */
export class VaultQuerySkill implements Skill {
  id = "vault_query";
  name = "Vault Query";
  description =
    "Counts, lists and reads the notes in the user's Obsidian vault, from Obsidian's own file list, so counts are exact. " +
    "Use it for any question about the vault itself: how many notes are about a topic, which notes are in a folder, have a tag or a property, " +
    "mention a phrase, or were created or changed in a period; to read a named note in full; or for an overview of the vault. " +
    "The vault passages sent with a message cannot answer these questions.";
  primaryParam = "topic";

  constructor(private plugin: HormePlugin) {}

  parameters: SkillParameter[] = [
    {
      name: "action",
      type: "string",
      description:
        '"find" (count and list notes; the default), "read" (one note in full, named in "note"), or "overview" (totals, biggest folders, most used tags).',
      required: false,
    },
    {
      name: "topic",
      type: "string",
      description:
        'What the notes are about, e.g. "stamps". Matches the title, aliases, folders, tags and property values, singular or plural; notes that only mention it in their text are counted separately.',
      required: false,
    },
    {
      name: "text",
      type: "string",
      description:
        'Exact words that must appear in the note text, e.g. "Stanley Gibbons". Lists every note holding them.',
      required: false,
    },
    {
      name: "folder",
      type: "string",
      description: "Only notes in this folder (its name or path) and its subfolders.",
      required: false,
    },
    {
      name: "tag",
      type: "string",
      description: 'Only notes with this tag, e.g. "stamps" (nested tags included).',
      required: false,
    },
    {
      name: "property",
      type: "string",
      description: 'Only notes with this property, e.g. "status".',
      required: false,
    },
    {
      name: "value",
      type: "string",
      description: 'With "property": only notes whose property holds this value.',
      required: false,
    },
    {
      name: "created_after",
      type: "string",
      description: "Only notes created on or after this date (YYYY-MM-DD).",
      required: false,
    },
    {
      name: "created_before",
      type: "string",
      description: "Only notes created before this date (YYYY-MM-DD).",
      required: false,
    },
    {
      name: "modified_after",
      type: "string",
      description: "Only notes changed on or after this date (YYYY-MM-DD).",
      required: false,
    },
    {
      name: "modified_before",
      type: "string",
      description: "Only notes changed before this date (YYYY-MM-DD).",
      required: false,
    },
    { name: "note", type: "string", description: 'For "read": the note\'s title or path.', required: false },
    {
      name: "limit",
      type: "number",
      description: "How many notes to list (default 20, at most 100). Counts are always complete.",
      required: false,
    },
    {
      name: "sort",
      type: "string",
      description: '"modified" (newest change first, the default), "created" or "name".',
      required: false,
    },
  ];

  /** Rebuilt on every request so the model knows today's date for "this week" or "last month". */
  get instructions(): string {
    return (
      `Today is ${isoDay(Date.now())}. To use this skill, output exactly: <call:vault_query>{"action": "find", "topic": "stamps"}</call>. ` +
      `More examples: {"action": "find", "folder": "Recipes"}; {"action": "find", "tag": "coins", "modified_after": "2026-11-01"}; ` +
      `{"action": "find", "text": "Stanley Gibbons"}; {"action": "read", "note": "Inverted Jenny"}; {"action": "overview"}. ` +
      `Give the counts it returns exactly, say how the notes were matched, and link notes as [[Note name]].`
    );
  }

  /** The same privacy rule as Vault Brain: a cloud model gets notes only with the user's consent. */
  private allowed(): boolean {
    return this.plugin.isLocalProviderActive() || this.plugin.settings.allowCloudRAG;
  }

  async execute(params: unknown): Promise<string> {
    if (!this.allowed()) {
      return "The vault cannot be read with this provider: notes are not sent to cloud providers unless the user allows it (Settings → Horme → Vault Brain).";
    }
    const { notes, drawings } = this.collectNotes();
    const action = (getStringProp(params, "action") ?? "find").trim().toLowerCase();
    if (action === "read")
      return this.read(notes, getStringProp(params, "note") ?? getStringProp(params, "topic") ?? "");
    if (action === "overview" || action === "stats") return this.overview(notes, drawings);
    return this.find(notes, drawings, params);
  }

  /** Every Markdown note with its metadata. Excalidraw drawings are counted apart. */
  private collectNotes(): { notes: NoteInfo[]; drawings: number } {
    const { vault, metadataCache } = this.plugin.app;
    const notes: NoteInfo[] = [];
    let drawings = 0;
    for (const file of vault.getMarkdownFiles()) {
      const cache = metadataCache.getFileCache(file);
      const fm = (cache?.frontmatter ?? {}) as Record<string, unknown>;
      if (/\.excalidraw\.md$/i.test(file.path) || "excalidraw-plugin" in fm) {
        drawings++;
        continue;
      }
      const properties: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fm)) if (k !== "position") properties[k] = v;
      notes.push({
        path: file.path,
        title: file.basename,
        folder: file.parent && !file.parent.isRoot() ? file.parent.path : "",
        tags: cache ? (getAllTags(cache) ?? []).map((t) => t.replace(/^#/, "")) : [],
        aliases: parseFrontMatterAliases(fm) ?? [],
        properties,
        created: file.stat.ctime,
        modified: file.stat.mtime,
      });
    }
    return { notes, drawings };
  }

  private filtersFrom(params: unknown): { filters: QueryFilters; described: string[]; ignored: string[] } {
    const str = (k: string) => getStringProp(params, k)?.trim() || undefined;
    const described: string[] = [];
    const ignored: string[] = [];
    const filters: QueryFilters = {
      topic: str("topic"),
      text: str("text"),
      folder: str("folder"),
      tag: str("tag"),
      property: str("property"),
      value: str("value"),
    };
    if (filters.topic) described.push(`about "${filters.topic}"`);
    if (filters.text) described.push(`text holds "${filters.text}"`);
    if (filters.folder) described.push(`in folder "${filters.folder}"`);
    if (filters.tag) described.push(`tagged #${filters.tag.replace(/^#/, "")}`);
    if (filters.property)
      described.push(
        filters.value ? `${filters.property}: ${filters.value}` : `has property "${filters.property}"`,
      );
    if (filters.value && !filters.property) ignored.push(`value "${filters.value}" (no property given)`);
    const dates: Array<[string, keyof QueryFilters, string]> = [
      ["created_after", "createdAfter", "created on or after"],
      ["created_before", "createdBefore", "created before"],
      ["modified_after", "modifiedAfter", "changed on or after"],
      ["modified_before", "modifiedBefore", "changed before"],
    ];
    for (const [param, key, label] of dates) {
      const raw = str(param);
      if (!raw) continue;
      const ms = parseDay(raw);
      if (ms === undefined) ignored.push(`${param} "${raw}" (not a YYYY-MM-DD date)`);
      else {
        (filters as Record<string, unknown>)[key] = ms;
        described.push(`${label} ${raw}`);
      }
    }
    return { filters, described, ignored };
  }

  private async find(all: NoteInfo[], drawings: number, params: unknown): Promise<string> {
    const { filters, described, ignored } = this.filtersFrom(params);
    const rawLimit = getNumberProp(params, "limit") ?? Number(getStringProp(params, "limit") ?? NaN);
    const limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(100, Math.round(rawLimit)) : 20;
    const sortRaw = (getStringProp(params, "sort") ?? "modified").toLowerCase();
    const sort: SortOrder = sortRaw === "name" || sortRaw === "created" ? sortRaw : "modified";

    const lines: string[] = [];
    lines.push("VAULT QUERY RESULT (from Obsidian's own file list: the counts are exact)");
    lines.push(
      `Vault: ${all.length.toLocaleString("en-GB")} notes${drawings ? ` (and ${drawings} Excalidraw drawings, not counted)` : ""}.`,
    );
    lines.push(`Asked for: ${described.length ? described.join("; ") : "all notes"}.`);
    if (ignored.length) lines.push(`Ignored: ${ignored.join("; ")}.`);

    const pool = applyFilters(all, filters);
    const topic = filters.topic ? topicMatcher(filters.topic) : null;
    const phrase = filters.text ? phraseMatcher(filters.text) : null;

    // Topic: notes about it by title, folder, tag or property; the rest of the
    // pool is searched for it in the text.
    let about: NoteInfo[] = pool;
    const ways = new Map<MatchWay, number>();
    if (topic) {
      about = [];
      for (const n of pool) {
        const w = topicWays(n, topic);
        if (!w.length) continue;
        about.push(n);
        for (const x of w) ways.set(x, (ways.get(x) ?? 0) + 1);
      }
    }

    // Reading note text is needed for "text", and to count notes that only mention the topic.
    const needText = phrase !== null || topic !== null;
    let mentions: NoteInfo[] = [];
    const snippets = new Map<string, string>();
    let scanned = 0;
    let toScan: NoteInfo[] = [];
    if (needText) {
      const aboutSet = new Set(about);
      toScan = phrase ? (topic ? about : pool) : pool.filter((n) => !aboutSet.has(n));
      const started = Date.now();
      const hits: NoteInfo[] = [];
      const files = new Map(this.plugin.app.vault.getMarkdownFiles().map((f) => [f.path, f]));
      for (let i = 0; i < toScan.length; i += 40) {
        if (Date.now() - started > TEXT_SCAN_MS) break;
        const batch = toScan.slice(i, i + 40);
        const texts = await Promise.all(
          batch.map(async (n) => {
            const f = files.get(n.path);
            if (!(f instanceof TFile)) return "";
            try {
              return await this.plugin.app.vault.cachedRead(f);
            } catch {
              return "";
            }
          }),
        );
        batch.forEach((n, j) => {
          const test = phrase ?? topic;
          if (test && test(texts[j])) {
            hits.push(n);
            if (phrase && filters.text) snippets.set(n.path, snippet(texts[j], filters.text));
          }
        });
        scanned += batch.length;
      }
      if (phrase) about = hits;
      else mentions = hits;
    }
    const partial = needText && scanned < toScan.length;

    if (phrase) {
      lines.push(`Notes whose text holds "${filters.text}": ${about.length}${partial ? " or more" : ""}.`);
    } else if (topic) {
      lines.push(`Notes about "${filters.topic}" (title, folder, tag or property): ${about.length}.`);
      if (about.length) {
        const parts = (["title", "folder", "tag", "property"] as MatchWay[])
          .filter((w) => ways.get(w))
          .map((w) => `${WAY_LABEL[w]} ${ways.get(w)}`);
        lines.push(
          `  Matched by ${parts.join(", ")} (a note can match in several ways; the title includes aliases).`,
        );
      }
      lines.push(
        `Other notes that mention "${filters.topic}" only in their text: ${mentions.length}${partial ? " or more" : ""}.`,
      );
    } else {
      lines.push(`Notes found: ${about.length}.`);
    }
    if (partial)
      lines.push(`(Text search stopped after ${scanned} of ${toScan.length} notes: it took too long.)`);

    // List the notes about the topic; when none, those that mention it.
    const listed = about.length ? about : mentions;
    if (listed.length > 1) {
      const folders = countByTopFolder(listed, 8)
        .map(([f, n]) => `${f} ${n}`)
        .join(" · ");
      lines.push(`By folder: ${folders}`);
    }
    if (listed.length) {
      const shown = sortNotes(listed, sort).slice(0, limit);
      const order =
        sort === "name" ? "by name" : sort === "created" ? "newest first" : "most recently changed first";
      const which = listed === mentions ? "notes that mention it" : "notes";
      lines.push(
        shown.length < listed.length
          ? `The first ${shown.length} of ${listed.length} ${which}, ${order}:`
          : `The ${which}, ${order}:`,
      );
      for (const n of shown) {
        const where = n.folder ? ` — ${n.folder}` : "";
        const quote = snippets.get(n.path);
        lines.push(
          `- ${noteLink(n)}${where} — changed ${isoDay(n.modified)}${quote ? `\n  "${quote}"` : ""}`,
        );
      }
    }
    lines.push(
      topic
        ? "Give these counts exactly and say how the notes were matched (title, folder, tag or property). Link notes as [[Note name]]."
        : "Give these counts exactly. Link notes as [[Note name]].",
    );
    return lines.join("\n");
  }

  private async read(all: NoteInfo[], name: string): Promise<string> {
    if (!name.trim()) return 'Name the note to read, e.g. {"action": "read", "note": "Inverted Jenny"}.';
    const { note, candidates } = findNote(all, name);
    if (!note) {
      if (!candidates.length) return `No note called "${name}" in the vault.`;
      const list = candidates
        .slice(0, 15)
        .map((n) => `- ${noteLink(n)}${n.folder ? ` — ${n.folder}` : ""}`)
        .join("\n");
      return `Several notes match "${name}"; ask which one, or read one by its path:\n${list}`;
    }
    const file = this.plugin.app.vault.getAbstractFileByPath(note.path);
    if (!(file instanceof TFile)) return `The note "${name}" could not be opened.`;
    const text = await this.plugin.app.vault.cachedRead(file);
    const max = this.plugin.isLocalProviderActive() ? READ_CHARS_LOCAL : READ_CHARS_CLOUD;
    const cut = text.length > max;
    return (
      `NOTE ${noteLink(note)} (${note.path}; created ${isoDay(note.created)}, changed ${isoDay(note.modified)}` +
      `${note.tags.length ? `; tags ${note.tags.map((t) => `#${t}`).join(" ")}` : ""})\n` +
      `${cut ? `[Only the first ${max.toLocaleString("en-GB")} of ${text.length.toLocaleString("en-GB")} characters.]\n` : ""}` +
      `---\n${cut ? text.slice(0, max) : text}\n---`
    );
  }

  private overview(all: NoteInfo[], drawings: number): string {
    const now = Date.now();
    const days = (n: number) => all.filter((x) => x.modified >= now - n * 86_400_000).length;
    const props = new Map<string, number>();
    for (const n of all) for (const k of Object.keys(n.properties)) props.set(k, (props.get(k) ?? 0) + 1);
    const topProps = [...props].sort((a, b) => b[1] - a[1]).slice(0, 10);
    const untagged = all.filter((n) => n.tags.length === 0).length;
    const lines = [
      "VAULT OVERVIEW (from Obsidian's own file list: the counts are exact)",
      `Notes: ${all.length.toLocaleString("en-GB")}${drawings ? ` (and ${drawings} Excalidraw drawings)` : ""}. Without tags: ${untagged}.`,
      `Changed in the last 7 days: ${days(7)}; last 30 days: ${days(30)}.`,
      `Folders (first level): ${countByTopFolder(all, 15)
        .map(([f, n]) => `${f} ${n}`)
        .join(" · ")}`,
      `Most used tags: ${
        countByTag(all, 20)
          .map(([t, n]) => `#${t} ${n}`)
          .join(" · ") || "none"
      }`,
      `Most used properties: ${topProps.map(([k, n]) => `${k} ${n}`).join(" · ") || "none"}`,
    ];
    return lines.join("\n");
  }
}
