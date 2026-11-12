/**
 * Images found by the find_image skill (and the Wikipedia skill). A skill's
 * result text carries them in a hidden block, so the chat can draw them as
 * cards, also when a saved conversation is opened again. The block is removed
 * from what the model reads.
 */

import { isPublicHttpUrl } from "./urlSafety";

export interface FoundImage {
  /** Where it was found, e.g. "Wikimedia Commons", "Pexels". */
  source: string;
  /** Short title. */
  title: string;
  /** Picture shown in the chat: a thumbnail or web-sized copy. */
  thumbUrl: string;
  /** A larger copy used by "Save to vault" (never a huge original). */
  saveUrl: string;
  /** The picture's page at its source, with its licence and author. */
  pageUrl: string;
  author: string;
  licence: string;
  description: string;
  width: number;
  height: number;
  /** Unsplash: an address its guidelines ask to call when a picture is downloaded. */
  downloadPing?: string;
}

/** Pictures are loaded and saved only from public https addresses. */
export function isAllowedImageUrl(url: string): boolean {
  return /^https:\/\//i.test(url) && isPublicHttpUrl(url);
}

const BLOCK_START = "<!-- horme-images:";
const BLOCK_RE = /<!-- horme-images:([A-Za-z0-9+/=]*) -->/g;

/** Only Wikimedia's image servers are ever loaded or downloaded. */
export function isWikimediaImageUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return (
    u.protocol === "https:" && (u.hostname === "upload.wikimedia.org" || u.hostname === "thumb.wikimedia.org")
  );
}

/** A file page on a Wikimedia wiki (Commons or a Wikipedia). */
export function isWikimediaPageUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === "https:" && /^([a-z-]+\.)?(wikimedia|wikipedia)\.org$/.test(u.hostname);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** Drops Wikimedia's tracking parameters (utm_*) from an address. */
export function withoutTracking(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) if (key.startsWith("utm_")) u.searchParams.delete(key);
    return u.toString();
  } catch {
    return url;
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Elements Wikimedia hides from readers, such as the "title QS:P1476,…" data on artworks. */
const HIDDEN_ELEMENT =
  /<(div|span)\b[^>]*\bstyle\s*=\s*["'][^"']*display\s*:\s*none[^"']*["'][^>]*>[\s\S]*?<\/\1\s*>/gi;

/** Plain text from the small HTML snippets in Wikimedia's metadata (author, description). */
export function htmlToText(html: string): string {
  return html
    .replace(HIDDEN_ELEMENT, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
      if (code[0] === "#") {
        const n =
          code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[code.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** The hidden block that carries images in a skill result. */
export function imageBlock(images: FoundImage[]): string {
  return `${BLOCK_START}${toBase64(JSON.stringify(images))} -->`;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** The images in a skill result; addresses outside Wikimedia are dropped. */
export function imagesFromSkillResult(result: string): FoundImage[] {
  const out: FoundImage[] = [];
  for (const m of result.matchAll(BLOCK_RE)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fromBase64(m[1]));
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const item of parsed as unknown[]) {
      if (typeof item !== "object" || item === null) continue;
      const r = item as Record<string, unknown>;
      const thumbUrl = str(r.thumbUrl);
      if (!isAllowedImageUrl(thumbUrl)) continue;
      const saveUrl = isAllowedImageUrl(str(r.saveUrl)) ? str(r.saveUrl) : thumbUrl;
      const ping = str(r.downloadPing);
      out.push({
        // Pictures saved before sources were added came from Wikimedia.
        source: str(r.source) || "Wikimedia Commons",
        title: str(r.title),
        thumbUrl,
        saveUrl,
        pageUrl: isAllowedImageUrl(str(r.pageUrl)) ? str(r.pageUrl) : "",
        author: str(r.author),
        licence: str(r.licence),
        description: str(r.description),
        width: num(r.width),
        height: num(r.height),
        ...(isAllowedImageUrl(ping) ? { downloadPing: ping } : {}),
      });
    }
  }
  return out;
}

/** The skill result as the model should read it: without the hidden image data. */
export function withoutImageData(text: string): string {
  return text
    .replace(BLOCK_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

/** "Diliff · CC BY-SA 2.5": the credit line under an image. */
export function imageCredit(img: Pick<FoundImage, "author" | "licence">): string {
  return [img.author, img.licence].filter(Boolean).join(" · ");
}

/** The credit on a card: author, licence and source, the source once ("Diliff · CC BY-SA 4.0 · Wikimedia Commons"). */
export function cardCredit(img: Pick<FoundImage, "author" | "licence" | "source">): string {
  return [imageCredit(img), img.source && !img.author.includes(img.source) ? img.source : ""]
    .filter(Boolean)
    .join(" · ");
}

/** The reply under pictures shown without the model: each title and its credit. */
export function imagesSummary(images: FoundImage[]): string {
  return images
    .map((img) => {
      const title = img.title.replace(/[[\]*_]/g, "");
      const credit = cardCredit(img);
      return `- **${title}**${credit ? ` — ${credit}` : ""}`;
    })
    .join("\n");
}

/** Markdown for pictures, each with its credit line, for conversations saved as notes. */
export function imagesToMarkdown(images: FoundImage[]): string {
  return images
    .map((img) => {
      const alt = img.title.replace(/[[\]]/g, "");
      const credit = imageCredit(img);
      return `![${alt}](${img.thumbUrl})${credit ? `\n*${credit}*` : ""}`;
    })
    .join("\n\n");
}

/** The file extension for a picture's content type ("image/png" → "png"); undefined when unknown. */
export function extensionForType(contentType: string): string | undefined {
  const m = /^image\/(jpeg|jpg|png|gif|webp|avif)\b/i.exec(contentType.trim());
  if (!m) return undefined;
  const t = m[1].toLowerCase();
  return t === "jpeg" ? "jpg" : t;
}

/** A file name for a saved image: the title, made safe, with the image's own extension. */
export function imageFileName(img: Pick<FoundImage, "title" | "saveUrl">, knownExt?: string): string {
  let ext = knownExt ?? "jpg";
  try {
    const last = new URL(img.saveUrl).pathname.split("/").pop() ?? "";
    const m = /\.(jpe?g|png|gif|webp)$/i.exec(last);
    if (m && !knownExt) ext = m[1].toLowerCase() === "jpeg" ? "jpg" : m[1].toLowerCase();
  } catch {
    // keep jpg
  }
  const base =
    img.title
      .replace(/\.(jpe?g|png|gif|webp|svg|tiff?)$/i, "")
      .replace(/[\\/:*?"<>|#^[\]]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "Image";
  return `${base}.${ext}`;
}

/**
 * Wikimedia often names an uploader by their user pages ("it:Utente:Andtofa User:Andtofa");
 * the name alone is kept ("Andtofa"), and a name repeated in a row is given once.
 */
export function cleanAuthor(author: string): string {
  const cleaned = author
    .replace(
      /(^|[\s(])(?:[a-z]{2,3}(?:-[a-z]+)?:)?(?:User|Utente|Usuario|Usuari|Utilisateur|Benutzer|Gebruiker|Użytkownik|Usuário):/gi,
      "$1",
    )
    .replace(/\s+/g, " ")
    .trim();
  const words = cleaned.split(" ");
  return words.filter((w, i) => i === 0 || w !== words[i - 1]).join(" ");
}

/** One file's entry from a MediaWiki `prop=imageinfo` answer (formatversion=2). */
export function imageFromInfo(page: unknown): FoundImage | null {
  if (typeof page !== "object" || page === null) return null;
  const p = page as Record<string, unknown>;
  const infos = Array.isArray(p.imageinfo) ? (p.imageinfo as unknown[]) : [];
  const info = infos[0];
  if (typeof info !== "object" || info === null) return null;
  const i = info as Record<string, unknown>;
  const mime = str(i.mime);
  if (mime && !/^image\/(jpeg|png|gif|webp|svg\+xml|tiff)$/.test(mime)) return null;
  const thumbUrl = withoutTracking(str(i.thumburl));
  if (!isWikimediaImageUrl(thumbUrl)) return null;
  const responsive = i.responsiveUrls;
  const larger =
    typeof responsive === "object" && responsive !== null
      ? str((responsive as Record<string, unknown>)["2"])
      : "";
  const saveUrl = isWikimediaImageUrl(withoutTracking(larger)) ? withoutTracking(larger) : thumbUrl;
  const meta =
    typeof i.extmetadata === "object" && i.extmetadata !== null
      ? (i.extmetadata as Record<string, unknown>)
      : {};
  const field = (key: string): string => {
    const f = meta[key];
    return typeof f === "object" && f !== null ? htmlToText(str((f as Record<string, unknown>).value)) : "";
  };
  const fileTitle = str(p.title).replace(/^[^:]+:/, "");
  const title = field("ObjectName") || fileTitle.replace(/\.[a-z0-9]{2,5}$/i, "") || "Image";
  let description = field("ImageDescription");
  if (description.length > 240) description = `${description.slice(0, 237).trimEnd()}…`;
  const pageUrl = withoutTracking(str(i.descriptionurl));
  return {
    source: /(^|\.)wikipedia\.org$/.test(hostOf(pageUrl)) ? "Wikipedia" : "Wikimedia Commons",
    title,
    thumbUrl,
    saveUrl,
    pageUrl: isWikimediaPageUrl(pageUrl) ? pageUrl : "",
    author: cleanAuthor(field("Artist")).slice(0, 120),
    licence: field("LicenseShortName"),
    description: description === title ? "" : description,
    width: num(i.width),
    height: num(i.height),
  };
}
