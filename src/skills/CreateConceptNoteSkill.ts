import { App, normalizePath, requestUrl } from "obsidian";
import HormePlugin from "../../main";
import { Skill, SkillParameter } from "./types";
import { asArray, errorToMessage, getRecordProp, getStringProp, isRecord } from "../utils/TypeGuards";

type ReputableContent = { content: string; url: string };

export class CreateConceptNoteSkill implements Skill {
  id = "create_concept_note";
  name = "Create Concept Note";
  description = "Researches a term via Wikipedia/Wiktionary and creates a permanent note in the vault.";

  parameters: SkillParameter[] = [
    {
      name: "title",
      type: "string",
      description: "The term or concept to research and save.",
      required: true,
    },
    {
      name: "language",
      type: "string",
      description: "Wikipedia language code to use (e.g. 'en', 'es', 'fr'). Defaults to the user's language when possible, otherwise 'en'.",
      required: false,
    },
  ];

  instructions =
    'Use this skill to research a term and save it to the vault: <call:create_concept_note>{"title":"term","language":"en"}</call>. ' +
    "The skill uses Wikipedia first, then Wiktionary as a fallback, and creates a note using the user's configured template.";

  constructor(private app: App, private plugin: HormePlugin) {}

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

  private async fetchReputableContent(title: string, lang: string): Promise<ReputableContent> {
    const slug = encodeURIComponent(title.trim().replace(/\s+/g, "_"));
    if (!slug) return { content: "", url: "" };

    // 1) Wikipedia summary (most reliable single-paragraph extract)
    try {
      const base = `https://${lang}.wikipedia.org`;
      const wikiUrl = `${base}/wiki/${slug}`;
      const wikiApiUrl = `${base}/api/rest_v1/page/summary/${slug}`;
      const res = await requestUrl({ url: wikiApiUrl, throw: false });
      if (res.status === 200) {
        const extract = getStringProp(res.json as unknown, "extract");
        if (extract && extract.trim().length > 0) return { content: extract.trim(), url: wikiUrl };
      }
    } catch {
      // Fall through
    }

    // 2) Wiktionary definition (shorter, but acceptable fallback)
    try {
      const wiktBase = `https://${lang}.wiktionary.org`;
      const wiktUrl = `${wiktBase}/wiki/${slug}`;
      const wiktApiUrl = `${wiktBase}/api/rest_v1/page/definition/${slug}`;
      const res = await requestUrl({ url: wiktApiUrl, throw: false });
      if (res.status === 200 && isRecord(res.json)) {
        const enArr = asArray(getRecordProp(res.json, "en")) ?? [];
        const first = enArr[0];
        const definitions = asArray(getRecordProp(first, "definitions")) ?? [];
        const def0 = definitions[0];
        const defText = getStringProp(def0, "definition");
        if (defText && defText.trim().length > 0) {
          const clean = defText.replace(/<[^>]*>/g, "").trim();
          if (clean) return { content: clean, url: wiktUrl };
        }
      }
    } catch {
      // Fall through
    }

    return { content: "", url: "" };
  }

  private async ensureFolderPath(folderPath: string): Promise<void> {
    const normalized = normalizePath(folderPath).replace(/\/+$/, "");
    if (!normalized || normalized === "/" || normalized === ".") return;

    const adapter = this.app.vault.adapter;
    const segments = normalized.split("/").filter(Boolean);
    let currentPath = "";
    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      if (!(await adapter.exists(currentPath))) {
        await this.app.vault.createFolder(currentPath);
      }
    }
  }

  async execute(params: unknown): Promise<string> {
    try {
      const title = getStringProp(params, "title")?.trim();
      if (!title) return `Invalid parameters for ${this.name}: expected {"title": string}.`;
      const lang = this.normalizeLang(getStringProp(params, "language"));

      const { conceptNoteFolder, conceptNoteTemplate, conceptNoteSourceField } = this.plugin.settings;
      const folderPath = normalizePath((conceptNoteFolder || "").trim());
      if (!folderPath) return "Error: concept note folder is not configured.";

      // 1) Research
      const { content, url } = await this.fetchReputableContent(title, lang);
      if (!content) {
        return `Error: I could not find a reputable explanation for "${title}" on Wikipedia or Wiktionary.`;
      }

      // 2) Ensure destination folder exists
      await this.ensureFolderPath(folderPath);

      // 3) Render template with snake_case tag + configurable source field
      const snakeTag = title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
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
      const filePath = normalizePath(`${folderPath}/${fileName}`);

      if (this.app.vault.getAbstractFileByPath(filePath)) {
        return `Note [[${safeBase || title}]] already exists. Skipping creation to avoid overwriting.\n\nSource: ${url}`;
      }

      await this.app.vault.create(filePath, noteBody);
      return `Success! Created concept note [[${safeBase || title}]].\n\nSource: ${url}`;
    } catch (e: unknown) {
      return `Error: ${errorToMessage(e)}`;
    }
  }
}
