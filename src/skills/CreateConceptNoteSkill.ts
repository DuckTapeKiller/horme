import { App, normalizePath } from "obsidian";
import { ensureVaultFolder } from "../utils/vaultFolder";
import { requestUrlWithTimeout } from "../utils/requestWithTimeout";
import HormePlugin from "../../main";
import { Skill, SkillParameter } from "./types";
import { asArray, errorToMessage, getRecordProp, getStringProp, isRecord } from "../utils/TypeGuards";
import { WIKIMEDIA_HEADERS, searchWikipedia } from "../utils/webResearch";

/** What the note is made from; `title` is the article's own when a search found it. */
type ReputableContent = { content: string; url: string; title: string };

export class CreateConceptNoteSkill implements Skill {
  id = "create_concept_note";
  name = "Create Concept Note";
  description =
    "Writes a new note in the user's vault from Wikipedia's article on a term. Only when the user asks for a note to be created; never to look something up (use wikipedia for that).";

  /** "Create a concept note about …", "crea una nota sobre …": only then. */
  whenAsked =
    /\b(?:create|make|save|write|add|start|take|generate)\b[^.?!\n]{0,40}\bnotes?\b|\b(?:crea|créame|crear|haz|hazme|guarda|guárdame|guardar|escribe|escríbeme|añade|genera|genérame)\b[^.?!\n]{0,40}\bnotas?\b/i;

  parameters: SkillParameter[] = [
    {
      name: "title",
      type: "string",
      description:
        'The bare term or concept, one to three words ("scriptorium", not "scriptorium in medieval monasteries").',
      required: true,
    },
    {
      name: "language",
      type: "string",
      description:
        "Wikipedia language code to use (e.g. 'en', 'es', 'fr'). Defaults to the user's language when possible, otherwise 'en'.",
      required: false,
    },
  ];

  instructions =
    'Use this skill only when the user asks for a note to be created: <call:create_concept_note>{"title":"term","language":"en"}</call>. ' +
    "The skill uses Wikipedia first, then Wiktionary as a fallback, and creates a note using the user's configured template.";

  constructor(
    private app: App,
    private plugin: HormePlugin,
  ) {}

  private normalizeLang(input: string | undefined): string {
    const raw = (input || "").trim().toLowerCase();
    if (raw.length >= 2 && /^[a-z]{2,3}([-_][a-z0-9]+)?$/.test(raw)) return raw.slice(0, 2);

    const hint = (this.plugin.settings.grammarLanguage || "").toLowerCase();
    if (hint.includes("españ") || hint.includes("span")) return "es";
    if (hint.includes("fran") || hint.includes("french")) return "fr";
    if (hint.includes("deut") || hint.includes("german")) return "de";
    if (hint.includes("portu")) return "pt";
    if (hint.includes("ital")) return "it";
    if (hint.includes("catal")) return "ca";
    return "en";
  }

  /** Wikipedia's summary of one article; null for a missing or disambiguation page. */
  private async wikipediaSummary(title: string, lang: string): Promise<ReputableContent | null> {
    const slug = encodeURIComponent(title.trim().replace(/\s+/g, "_"));
    if (!slug) return null;
    const base = `https://${lang}.wikipedia.org`;
    try {
      const res = await requestUrlWithTimeout({
        url: `${base}/api/rest_v1/page/summary/${slug}`,
        headers: WIKIMEDIA_HEADERS,
        throw: false,
      });
      if (res.status !== 200) return null;
      const data = res.json as unknown;
      if (getStringProp(data, "type") === "disambiguation") return null;
      const extract = getStringProp(data, "extract")?.trim();
      if (!extract) return null;
      const real = getStringProp(data, "title") ?? title;
      return {
        content: extract,
        url: `${base}/wiki/${encodeURIComponent(real.replace(/ /g, "_"))}`,
        title: real,
      };
    } catch {
      return null;
    }
  }

  /**
   * Wikipedia's article on the term, found by its exact title or else by a
   * search (a phrase such as "scriptorium in medieval monasteries" has no
   * article of its own); Wiktionary's definition as the last resort.
   */
  private async fetchReputableContent(title: string, lang: string): Promise<ReputableContent | null> {
    const exact = await this.wikipediaSummary(title, lang);
    if (exact) return exact;

    const hits = await searchWikipedia(title, 3, lang).catch(() => []);
    for (const hit of hits) {
      if (/^(?:Category|Categoría|Catégorie|Kategorie|Categoria):/i.test(hit.title)) continue;
      const found = await this.wikipediaSummary(hit.title, lang);
      if (found) return found;
    }

    try {
      const slug = encodeURIComponent(title.trim().replace(/\s+/g, "_"));
      const wiktBase = `https://${lang}.wiktionary.org`;
      const res = await requestUrlWithTimeout({
        url: `${wiktBase}/api/rest_v1/page/definition/${slug}`,
        headers: WIKIMEDIA_HEADERS,
        throw: false,
      });
      if (res.status === 200 && isRecord(res.json)) {
        const enArr = asArray(getRecordProp(res.json, "en")) ?? [];
        const definitions = asArray(getRecordProp(enArr[0], "definitions")) ?? [];
        const clean = (getStringProp(definitions[0], "definition") ?? "").replace(/<[^>]*>/g, "").trim();
        if (clean) return { content: clean, url: `${wiktBase}/wiki/${slug}`, title };
      }
    } catch {
      // No definition either.
    }
    return null;
  }

  /** Creates the folder if needed and returns its path as the vault spells it. */
  private async ensureFolderPath(folderPath: string): Promise<string> {
    return ensureVaultFolder(this.app, folderPath);
  }

  async execute(params: unknown): Promise<string> {
    try {
      const asked = getStringProp(params, "title")?.trim();
      if (!asked) return `Invalid parameters for ${this.name}: expected {"title": string}.`;
      const lang = this.normalizeLang(getStringProp(params, "language"));

      const { conceptNoteFolder, conceptNoteTemplate, conceptNoteSourceField } = this.plugin.settings;
      const folderPath = normalizePath((conceptNoteFolder || "").trim());
      if (!folderPath) return "Error: concept note folder is not configured.";

      // 1) Research
      const found = await this.fetchReputableContent(asked, lang);
      if (!found) {
        return `No note was created: neither Wikipedia nor Wiktionary has an article on "${asked}". Tell the user plainly that the note was not made, and suggest a shorter term.`;
      }
      const { content, url, title } = found;
      // Found by a search: the note takes the article's name, and the reply says so.
      const renamed =
        title.toLowerCase() !== asked.toLowerCase() ? ` (Wikipedia's article for "${asked}")` : "";

      // 2) Ensure destination folder exists
      const folder = await this.ensureFolderPath(folderPath);

      // 3) Render template with snake_case tag + configurable source field
      const snakeTag = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
      const sourceField = (conceptNoteSourceField || "Source").trim() || "Source";
      const noteBody = (conceptNoteTemplate || "")
        .replace(/\$\{title\}/g, title)
        .replace(/\$\{tag\}/g, snakeTag || "concept")
        .replace(/\$\{source\}/g, url)
        .replace(/\$\{sourceField\}/g, sourceField)
        .replace(/\$\{content\}/g, content);

      // 4) Create note (do not overwrite)
      const safeBase = title.replace(/[\\/:*?"<>|]/g, "").trim();
      const fileName = `${safeBase || "Concept"}.md`;
      const filePath = normalizePath(`${folder}/${fileName}`);

      if (this.app.vault.getAbstractFileByPath(filePath)) {
        return `Note [[${safeBase || title}]] already exists. Skipping creation to avoid overwriting.\n\nSource: ${url}`;
      }

      await this.app.vault.create(filePath, noteBody);
      return `Success! Created concept note [[${safeBase || title}]]${renamed}.\n\nSource: ${url}`;
    } catch (e: unknown) {
      return `Error: ${errorToMessage(e)}`;
    }
  }
}
