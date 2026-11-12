import type HormePlugin from "../../main";
import { Skill, SkillParameter } from "./types";
import { errorToMessage, getRecordProp, getStringProp } from "../utils/TypeGuards";
import { FoundImage, imageBlock, imageCredit } from "../utils/images";
import { imageSourceInfo } from "../utils/imageSources";
import { searchSource, sourceReady } from "../services/ImageSearch";

/**
 * Finds pictures in the sources switched on in Horme's Images settings, in the
 * order set there, until it has as many as were asked for. The chat draws them
 * from the hidden block in the result; the model reads only titles and credits.
 */
export class FindImageSkill implements Skill {
  id = "find_image";
  name = "Find image";
  description =
    "Finds photos and pictures of places, buildings, people, artworks, animals, objects and scenes, and shows them in the chat with their author and licence.";
  terminal = true;
  primaryParam = "query";

  parameters: SkillParameter[] = [
    {
      name: "query",
      type: "string",
      description:
        'What to show: the name of the subject (e.g. "Colosseum", "Frida Kahlo", "The Starry Night") or a short description of a scene (e.g. "red fox in snow").',
      required: true,
    },
    {
      name: "count",
      type: "number",
      description: "How many pictures to show. Defaults to 1; use more only when the user asks for several.",
      required: false,
    },
    {
      name: "language",
      type: "string",
      description:
        "Wikipedia language code whose article picture is tried first (e.g. 'en', 'es'). Defaults to 'en'.",
      required: false,
    },
  ];

  instructions = `To use this skill, output exactly: <call:find_image>{"query": "Colosseum", "count": 1}</call>. Use it whenever the user asks to see, show or find a photo, picture, image, painting or portrait of something. Write the query as the subject's name, or a short description of a scene, in English when you can. The pictures are shown to the user automatically: never write image Markdown, image links or image addresses yourself. In your answer, say in one or two sentences what the picture shows and credit its author and licence.`;

  constructor(private plugin: HormePlugin) {}

  async execute(params: unknown): Promise<string> {
    try {
      const query = getStringProp(params, "query")?.trim();
      if (!query) return `Invalid parameters for ${this.name}: expected {"query": string, "count"?: number}.`;
      const max = this.plugin.settings.imageMaxCount;
      const count = this.readCount(getRecordProp(params, "count"), max);
      const langRaw = (getStringProp(params, "language") || "en").toLowerCase().trim();
      const lang = /^[a-z]{2,3}(-[a-z]+)?$/.test(langRaw) ? langRaw : "en";

      const sources = this.plugin.settings.imageSources.filter((s) => sourceReady(this.plugin, s.id));
      if (sources.length === 0) {
        const keyless = this.plugin.settings.imageSources
          .filter((s) => s.enabled)
          .map((s) => imageSourceInfo(s.id).name);
        return keyless.length
          ? `No picture source is ready: ${keyless.join(", ")} ${keyless.length === 1 ? "needs its key" : "need their keys"} in Horme's settings, under Images.`
          : "No picture source is switched on. Turn one on in Horme's settings, under Images.";
      }

      const images: FoundImage[] = [];
      const seen = new Set<string>();
      const add = (img: FoundImage): void => {
        if (images.length >= count) return;
        // The same picture is often uploaded twice under different names.
        const same = `${img.width}x${img.height}|${img.author}`;
        if (seen.has(img.thumbUrl) || (img.width > 0 && seen.has(same))) return;
        seen.add(img.thumbUrl);
        seen.add(same);
        images.push(img);
      };

      // Each source is asked only while more pictures are needed; one that fails
      // (no network, a wrong key) is skipped and named if nothing was found.
      const failures: string[] = [];
      for (const source of sources) {
        if (images.length >= count) break;
        try {
          for (const img of await searchSource(this.plugin, source.id, query, lang, count - images.length))
            add(img);
        } catch (e: unknown) {
          failures.push(`${imageSourceInfo(source.id).name}: ${errorToMessage(e)}`);
        }
      }

      if (images.length === 0) {
        if (failures.length === sources.length) return `Error: image search failed. ${failures.join(" ")}`;
        const tried = sources.map((s) => imageSourceInfo(s.id).name).join(", ");
        return `No pictures found for "${query}" (searched ${tried}).`;
      }

      const lines = images.map((img, i) => {
        const credit = imageCredit(img);
        const name = img.pageUrl ? `[${img.title.replace(/[[\]]/g, "")}](${img.pageUrl})` : img.title;
        const desc = img.description ? `\n   ${img.description}` : "";
        return `${i + 1}. ${name}${credit ? ` — ${credit}` : ""} (${img.source})${desc}`;
      });
      const shown = images.length === 1 ? "1 picture" : `${images.length} pictures`;
      return [
        `Shown in the chat: ${shown} of “${query}”.`,
        "",
        ...lines,
        "",
        "<!-- For the assistant: these pictures are already displayed to the user. Do not write image Markdown, image links or image addresses. Describe briefly what is shown and credit the author and licence. -->",
        imageBlock(images),
      ].join("\n");
    } catch (e: unknown) {
      return `Error: image search failed: ${errorToMessage(e)}`;
    }
  }

  private readCount(raw: unknown, max: number): number {
    const n = typeof raw === "number" ? raw : typeof raw === "string" ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) ? Math.min(max, Math.max(1, Math.round(n))) : 1;
  }
}
