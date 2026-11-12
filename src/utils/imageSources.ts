/**
 * The picture sources Find image can use, and how each one's answer becomes
 * the images the chat shows. Network calls live in services/ImageSearch.ts;
 * everything here is plain data handling, so it can be tested on its own.
 */

import { FoundImage, htmlToText, isAllowedImageUrl } from "./images";

export type ImageSourceId =
  | "wikimedia"
  | "openverse"
  | "met"
  | "nasa"
  | "artic"
  | "pexels"
  | "unsplash"
  | "brave";

export interface ImageSourceSetting {
  id: ImageSourceId;
  enabled: boolean;
}

/** Settings fields holding the keychain names of each source's keys. */
export type ImageSecretKey =
  | "imageOpenverseIdSecret"
  | "imageOpenverseSecretSecret"
  | "imagePexelsSecret"
  | "imageUnsplashSecret"
  | "imageBraveSecret";

export interface ImageSourceInfo {
  id: ImageSourceId;
  name: string;
  /** What it is good for, shown in settings. */
  desc: string;
  /** Keys the source needs; empty when it needs none. */
  keys: Array<{ key: ImageSecretKey; name: string }>;
  enabledByDefault: boolean;
  /** Where to get a key. */
  signUpUrl?: string;
}

export const IMAGE_SOURCES: ImageSourceInfo[] = [
  {
    id: "wikimedia",
    name: "Wikipedia and Wikimedia Commons",
    desc: "The picture at the top of the Wikipedia article, then Commons. People, places, buildings, artworks, animals. Free licences.",
    keys: [],
    enabledByDefault: true,
  },
  {
    id: "openverse",
    name: "Openverse",
    desc: "Hundreds of millions of openly licensed pictures from Flickr, museums and other collections.",
    keys: [
      { key: "imageOpenverseIdSecret", name: "Openverse client ID" },
      { key: "imageOpenverseSecretSecret", name: "Openverse client secret" },
    ],
    enabledByDefault: false,
    signUpUrl: "https://api.openverse.org/v1/#tag/auth/operation/register",
  },
  {
    id: "met",
    name: "The Met",
    desc: "Public-domain artworks and objects from the Metropolitan Museum of Art.",
    keys: [],
    enabledByDefault: true,
  },
  {
    id: "nasa",
    name: "NASA",
    desc: "Space, planets, missions and Earth from orbit.",
    keys: [],
    enabledByDefault: true,
  },
  {
    id: "artic",
    name: "Art Institute of Chicago",
    desc: "Public-domain paintings and objects from the Art Institute of Chicago.",
    keys: [],
    enabledByDefault: false,
  },
  {
    id: "pexels",
    name: "Pexels",
    desc: "Stock photos of everyday subjects and scenes, free to use.",
    keys: [{ key: "imagePexelsSecret", name: "Pexels API key" }],
    enabledByDefault: false,
    signUpUrl: "https://www.pexels.com/api/",
  },
  {
    id: "unsplash",
    name: "Unsplash",
    desc: "Stock photos of everyday subjects and scenes, free to use.",
    keys: [{ key: "imageUnsplashSecret", name: "Unsplash access key" }],
    enabledByDefault: false,
    signUpUrl: "https://unsplash.com/developers",
  },
  {
    id: "brave",
    name: "Brave Search",
    desc: "Pictures from any website. Their licences are unknown: check the page before you reuse one.",
    keys: [{ key: "imageBraveSecret", name: "Brave Search API key" }],
    enabledByDefault: false,
    signUpUrl: "https://brave.com/search/api/",
  },
];

export function imageSourceInfo(id: ImageSourceId): ImageSourceInfo {
  return IMAGE_SOURCES.find((s) => s.id === id) ?? IMAGE_SOURCES[0];
}

export function defaultImageSources(): ImageSourceSetting[] {
  return IMAGE_SOURCES.map((s) => ({ id: s.id, enabled: s.enabledByDefault }));
}

/**
 * A saved source list made valid: known sources once each, in the saved order,
 * with any source added in a later version appended with its default.
 */
export function normalizeImageSources(saved: unknown): ImageSourceSetting[] {
  const out: ImageSourceSetting[] = [];
  const seen = new Set<string>();
  if (Array.isArray(saved)) {
    for (const item of saved as unknown[]) {
      if (typeof item !== "object" || item === null) continue;
      const r = item as Record<string, unknown>;
      const id = r.id;
      if (typeof id !== "string" || seen.has(id) || !IMAGE_SOURCES.some((s) => s.id === id)) continue;
      seen.add(id);
      out.push({ id: id as ImageSourceId, enabled: r.enabled === true });
    }
  }
  for (const s of IMAGE_SOURCES) if (!seen.has(s.id)) out.push({ id: s.id, enabled: s.enabledByDefault });
  return out;
}

/* ── Reading each service's answer ─────────────────────────────────────── */

function rec(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? (v as unknown[]) : [];
}
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
}
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Keeps a picture only when its addresses are safe to load. */
function checked(img: FoundImage): FoundImage | null {
  if (!isAllowedImageUrl(img.thumbUrl)) return null;
  if (!isAllowedImageUrl(img.saveUrl)) img.saveUrl = img.thumbUrl;
  if (img.pageUrl && !isAllowedImageUrl(img.pageUrl)) img.pageUrl = "";
  if (img.downloadPing && !isAllowedImageUrl(img.downloadPing)) delete img.downloadPing;
  img.title = cut(img.title || "Image", 160);
  img.author = cut(img.author, 120);
  img.description = cut(img.description, 240);
  return img;
}

/** "by-sa", "4.0" → "CC BY-SA 4.0"; "cc0" → "CC0"; "pdm" → "Public domain". */
export function openverseLicence(license: string, version: string): string {
  const l = license.toLowerCase();
  if (l === "pdm") return "Public domain";
  if (l === "cc0") return "CC0";
  if (!l) return "";
  return `CC ${l.toUpperCase()}${version ? ` ${version}` : ""}`;
}

/** Openverse /v1/images/ answer. */
export function parseOpenverse(json: unknown): FoundImage[] {
  return arr(rec(json).results)
    .map((r) => {
      const x = rec(r);
      const thumb = str(x.thumbnail) || str(x.url);
      return checked({
        source: "Openverse",
        title: htmlToText(str(x.title)),
        thumbUrl: thumb,
        saveUrl: str(x.url) || thumb,
        pageUrl: str(x.foreign_landing_url),
        author: htmlToText(str(x.creator)),
        licence: openverseLicence(str(x.license), str(x.license_version)),
        description: "",
        width: num(x.width),
        height: num(x.height),
      });
    })
    .filter((i): i is FoundImage => i !== null);
}

/** The Met: one /objects/{id} answer; only public-domain objects with a picture. */
export function parseMetObject(json: unknown): FoundImage | null {
  const o = rec(json);
  const small = str(o.primaryImageSmall);
  if (o.isPublicDomain !== true || !small) return null;
  const date = str(o.objectDate);
  return checked({
    source: "The Met",
    title: str(o.title) || str(o.objectName),
    thumbUrl: small,
    saveUrl: str(o.primaryImage) || small,
    pageUrl: str(o.objectURL),
    author: [str(o.artistDisplayName), date].filter(Boolean).join(", "),
    licence: "Public domain",
    description: "",
    width: 0,
    height: 0,
  });
}

/** Object ids from The Met's v1.1 search. */
export function parseMetSearch(json: unknown): number[] {
  return arr(rec(json).objectIDs).filter((n): n is number => typeof n === "number");
}

/** NASA Image and Video Library /search answer. Originals over 15 MB are not saved. */
export function parseNasa(json: unknown): FoundImage[] {
  return arr(rec(rec(json).collection).items)
    .map((it) => {
      const item = rec(it);
      const data = rec(arr(item.data)[0]);
      if (str(data.media_type) && str(data.media_type) !== "image") return null;
      const links = arr(item.links).map(rec);
      const byRel = (rel: string) => links.find((l) => str(l.rel) === rel);
      const shown = byRel("alternate") ?? byRel("preview");
      const original = byRel("canonical");
      if (!shown) return null;
      const big =
        original && num(original.size) > 0 && num(original.size) <= 15_000_000 ? str(original.href) : "";
      const id = str(data.nasa_id);
      return checked({
        source: "NASA",
        title: str(data.title),
        thumbUrl: str(shown.href),
        saveUrl: big || str(shown.href),
        pageUrl: id ? `https://images.nasa.gov/details/${encodeURIComponent(id)}` : "",
        author:
          str(data.photographer) ||
          str(data.secondary_creator) ||
          (str(data.center) ? `NASA ${str(data.center)}` : "NASA"),
        licence: "NASA, public domain",
        description: htmlToText(str(data.description_508) || str(data.description)),
        width: num(original?.width) || num(shown.width),
        height: num(original?.height) || num(shown.height),
      });
    })
    .filter((i): i is FoundImage => i !== null);
}

/** Art Institute of Chicago /artworks/search answer; only public-domain works with a picture. */
export function parseArtic(json: unknown): FoundImage[] {
  const root = rec(json);
  const iiif = str(rec(root.config).iiif_url) || "https://www.artic.edu/iiif/2";
  return arr(root.data)
    .map((d) => {
      const a = rec(d);
      const imageId = str(a.image_id);
      if (!imageId || a.is_public_domain !== true) return null;
      const id = str(a.id);
      const thumb = rec(a.thumbnail);
      return checked({
        source: "Art Institute of Chicago",
        title: str(a.title),
        thumbUrl: `${iiif}/${imageId}/full/843,/0/default.jpg`,
        saveUrl: `${iiif}/${imageId}/full/1686,/0/default.jpg`,
        pageUrl: id ? `https://www.artic.edu/artworks/${encodeURIComponent(id)}` : "",
        author: str(a.artist_display).split("\n")[0] ?? "",
        licence: "Public domain",
        description: htmlToText(str(thumb.alt_text)),
        width: num(thumb.width),
        height: num(thumb.height),
      });
    })
    .filter((i): i is FoundImage => i !== null);
}

/** Pexels /v1/search answer. Pexels asks for "Photo by … on Pexels". */
export function parsePexels(json: unknown): FoundImage[] {
  return arr(rec(json).photos)
    .map((p) => {
      const x = rec(p);
      const src = rec(x.src);
      const alt = str(x.alt);
      return checked({
        source: "Pexels",
        title: alt || "Photo",
        thumbUrl: str(src.large) || str(src.medium),
        saveUrl: str(src.large2x) || str(src.large),
        pageUrl: str(x.url),
        author: str(x.photographer) ? `Photo by ${str(x.photographer)} on Pexels` : "Pexels",
        licence: "",
        description: "",
        width: num(x.width),
        height: num(x.height),
      });
    })
    .filter((i): i is FoundImage => i !== null);
}

/** Adds Unsplash's referral parameters, which its guidelines ask for on every link back. */
export function unsplashLink(url: string): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    u.searchParams.set("utm_source", "horme");
    u.searchParams.set("utm_medium", "referral");
    return u.toString();
  } catch {
    return url;
  }
}

/** Unsplash /search/photos answer. Saving must call `downloadPing` first (Unsplash guidelines). */
export function parseUnsplash(json: unknown): FoundImage[] {
  return arr(rec(json).results)
    .map((r) => {
      const x = rec(r);
      const urls = rec(x.urls);
      const links = rec(x.links);
      const user = rec(x.user);
      const name = str(user.name);
      const img = checked({
        source: "Unsplash",
        title: str(x.description) || str(x.alt_description) || "Photo",
        thumbUrl: str(urls.small) || str(urls.regular),
        saveUrl: str(urls.regular) || str(urls.small),
        pageUrl: unsplashLink(str(links.html)),
        author: name ? `Photo by ${name} on Unsplash` : "Unsplash",
        licence: "",
        description: str(x.alt_description) && str(x.description) ? str(x.alt_description) : "",
        width: num(x.width),
        height: num(x.height),
        downloadPing: str(links.download_location),
      });
      return img;
    })
    .filter((i): i is FoundImage => i !== null);
}

/** Brave Search /images/search answer. The picture is shown through Brave's thumbnail. */
export function parseBrave(json: unknown): FoundImage[] {
  return arr(rec(json).results)
    .map((r) => {
      const x = rec(r);
      const thumb = str(rec(x.thumbnail).src);
      const original = str(rec(x.properties).url);
      let site = str(x.source);
      if (!site) {
        try {
          site = new URL(str(x.url)).hostname.replace(/^www\./, "");
        } catch {
          site = "";
        }
      }
      return checked({
        source: "Brave Search",
        title: htmlToText(str(x.title)),
        thumbUrl: thumb,
        saveUrl: original || thumb,
        pageUrl: str(x.url),
        author: site,
        licence: "Licence unknown",
        description: "",
        width: num(rec(x.properties).width),
        height: num(rec(x.properties).height),
      });
    })
    .filter((i): i is FoundImage => i !== null);
}
