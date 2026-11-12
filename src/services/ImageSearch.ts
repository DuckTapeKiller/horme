import type HormePlugin from "../../main";
import { requestUrlWithTimeout } from "../utils/requestWithTimeout";
import { asArray, errorToMessage, getRecordProp, getStringProp } from "../utils/TypeGuards";
import { WIKIMEDIA_HEADERS } from "../utils/webResearch";
import { FoundImage, imageFromInfo } from "../utils/images";
import {
  ImageSourceId,
  imageSourceInfo,
  parseArtic,
  parseBrave,
  parseMetObject,
  parseMetSearch,
  parseNasa,
  parseOpenverse,
  parsePexels,
  parseUnsplash,
} from "../utils/imageSources";

const HEADERS = WIKIMEDIA_HEADERS;

/** imageinfo request fields: a 960 px thumbnail, its page, author, licence and description. */
const IMAGE_INFO: Record<string, string> = {
  prop: "imageinfo",
  iiprop: "url|mime|size|extmetadata",
  iiurlwidth: "960",
  iiextmetadatafilter: "Artist|LicenseShortName|ImageDescription|ObjectName",
  format: "json",
  formatversion: "2",
};

function withQuery(base: string, params: Record<string, string>): string {
  return `${base}?${new URLSearchParams(params).toString()}`;
}

function pages(json: unknown): unknown[] {
  return asArray(getRecordProp(getRecordProp(json, "query"), "pages")) ?? [];
}

/** Reads a JSON answer, turning HTML (a bot check, an error page) into a clear error. */
function jsonOf(res: { status: number; text: string; json: unknown }, service: string): unknown {
  if (res.status === 401 || res.status === 403)
    throw new Error(
      `${service} refused the request (${res.status}). Check the key in Horme's Images settings.`,
    );
  if (res.status === 429) throw new Error(`${service} says too many requests; try again later.`);
  if (res.status !== 200) throw new Error(`${service} answered ${res.status}.`);
  if (/^\s*</.test(res.text))
    throw new Error(`${service} sent a web page instead of data (a bot check or an outage).`);
  return res.json;
}

/* ── Wikipedia and Wikimedia Commons ───────────────────────────────────── */

function wikiHost(lang: string): string {
  return /^[a-z]{2,3}(-[a-z]+)?$/.test(lang) ? `${lang}.wikipedia.org` : "en.wikipedia.org";
}

async function imageInfo(host: string, file: string): Promise<FoundImage | null> {
  // Asked on the same wiki, so pictures kept on that Wikipedia (not on Commons) are found too.
  const res = await requestUrlWithTimeout({
    url: withQuery(`https://${host}/w/api.php`, { action: "query", titles: `File:${file}`, ...IMAGE_INFO }),
    headers: HEADERS,
    throw: false,
  });
  return imageFromInfo(pages(jsonOf(res, "Wikipedia"))[0]);
}

/** The picture at the top of a Wikipedia article, by the article's exact title. */
export async function wikipediaArticlePicture(title: string, lang: string): Promise<FoundImage | null> {
  const host = wikiHost(lang);
  const res = await requestUrlWithTimeout({
    url: withQuery(`https://${host}/w/api.php`, {
      action: "query",
      titles: title,
      redirects: "1",
      prop: "pageimages",
      piprop: "name",
      format: "json",
      formatversion: "2",
    }),
    headers: HEADERS,
    throw: false,
  });
  const file = getStringProp(pages(jsonOf(res, "Wikipedia"))[0], "pageimage");
  return file ? imageInfo(host, file) : null;
}

/** The picture at the top of the Wikipedia article that best matches a search. */
async function wikipediaLeadPicture(query: string, lang: string): Promise<FoundImage | null> {
  const host = wikiHost(lang);
  const res = await requestUrlWithTimeout({
    url: withQuery(`https://${host}/w/api.php`, {
      action: "query",
      generator: "search",
      gsrsearch: query,
      gsrlimit: "1",
      prop: "pageimages",
      piprop: "name",
      format: "json",
      formatversion: "2",
    }),
    headers: HEADERS,
    throw: false,
  });
  const file = getStringProp(pages(jsonOf(res, "Wikipedia"))[0], "pageimage");
  return file ? imageInfo(host, file) : null;
}

async function commonsSearch(query: string, limit: number): Promise<FoundImage[]> {
  const res = await requestUrlWithTimeout({
    url: withQuery("https://commons.wikimedia.org/w/api.php", {
      action: "query",
      generator: "search",
      gsrnamespace: "6",
      gsrsearch: `${query} filetype:bitmap`,
      gsrlimit: String(limit),
      ...IMAGE_INFO,
    }),
    headers: HEADERS,
    throw: false,
  });
  const indexOf = (p: unknown): number => {
    const i = getRecordProp(p, "index");
    return typeof i === "number" ? i : Number.MAX_SAFE_INTEGER;
  };
  return (
    [...pages(jsonOf(res, "Wikimedia Commons"))]
      .sort((a, b) => indexOf(a) - indexOf(b))
      .map((p) => imageFromInfo(p))
      .filter((img): img is FoundImage => img !== null)
      // Icons, flags and small scans are not what a "photo of" asks for.
      .filter((img) => !(img.width > 0 && img.width < 300 && img.height < 300))
  );
}

/* ── The other sources ─────────────────────────────────────────────────── */

let openverseToken: { clientId: string; token: string; expires: number } | null = null;

async function openverseAuth(clientId: string, clientSecret: string): Promise<string> {
  if (openverseToken && openverseToken.clientId === clientId && openverseToken.expires > Date.now() + 60_000)
    return openverseToken.token;
  const res = await requestUrlWithTimeout({
    url: "https://api.openverse.org/v1/auth_tokens/token/",
    method: "POST",
    headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
    throw: false,
  });
  const json = jsonOf(res, "Openverse");
  const token = getStringProp(json, "access_token");
  const expiresIn = getRecordProp(json, "expires_in");
  if (!token) throw new Error("Openverse did not return an access token.");
  openverseToken = {
    clientId,
    token,
    expires: Date.now() + (typeof expiresIn === "number" ? expiresIn : 3600) * 1000,
  };
  return token;
}

/** Keys a source needs, read from Obsidian's keychain; null when one is missing. */
export function sourceKeys(plugin: HormePlugin, id: ImageSourceId): string[] | null {
  const values = imageSourceInfo(id).keys.map((k) => plugin.getSecretValue(plugin.settings[k.key]));
  return values.every((v) => v.trim()) ? values.map((v) => v.trim()) : null;
}

/** True when a source can be asked: switched on, and with its keys set. */
export function sourceReady(plugin: HormePlugin, id: ImageSourceId): boolean {
  const entry = plugin.settings.imageSources.find((s) => s.id === id);
  return Boolean(entry?.enabled) && sourceKeys(plugin, id) !== null;
}

/** Up to `limit` pictures from one source, best first. */
export async function searchSource(
  plugin: HormePlugin,
  id: ImageSourceId,
  query: string,
  lang: string,
  limit: number,
): Promise<FoundImage[]> {
  const keys = sourceKeys(plugin, id);
  if (!keys) throw new Error(`${imageSourceInfo(id).name} needs a key in Horme's Images settings.`);
  const n = String(Math.max(1, Math.min(20, limit)));

  switch (id) {
    case "wikimedia": {
      const out: FoundImage[] = [];
      const lead = await wikipediaLeadPicture(query, lang).catch(() => null);
      if (lead) out.push(lead);
      if (out.length < limit) out.push(...(await commonsSearch(query, limit + 4)));
      return out;
    }
    case "openverse": {
      const token = await openverseAuth(keys[0], keys[1]);
      const res = await requestUrlWithTimeout({
        url: withQuery("https://api.openverse.org/v1/images/", { q: query, page_size: n, mature: "false" }),
        headers: { ...HEADERS, Authorization: `Bearer ${token}` },
        throw: false,
      });
      if (res.status === 401) openverseToken = null;
      return parseOpenverse(jsonOf(res, "Openverse"));
    }
    case "met": {
      const res = await requestUrlWithTimeout({
        url: withQuery("https://collectionapi.metmuseum.org/public/collection/v1.1/search", {
          q: query,
          hasImages: "true",
          limit: "12",
        }),
        headers: HEADERS,
        throw: false,
      });
      const ids = parseMetSearch(jsonOf(res, "The Met"));
      const out: FoundImage[] = [];
      // One request per object; stop once there are enough public-domain pictures.
      for (const objectId of ids.slice(0, Math.min(12, limit * 3))) {
        if (out.length >= limit) break;
        const obj = await requestUrlWithTimeout({
          url: `https://collectionapi.metmuseum.org/public/collection/v1/objects/${objectId}`,
          headers: HEADERS,
          throw: false,
        }).catch(() => null);
        if (!obj || obj.status !== 200) continue;
        const img = parseMetObject(obj.json);
        if (img) out.push(img);
      }
      return out;
    }
    case "nasa": {
      const res = await requestUrlWithTimeout({
        url: withQuery("https://images-api.nasa.gov/search", { q: query, media_type: "image", page_size: n }),
        headers: HEADERS,
        throw: false,
      });
      return parseNasa(jsonOf(res, "NASA"));
    }
    case "artic": {
      const res = await requestUrlWithTimeout({
        url: withQuery("https://api.artic.edu/api/v1/artworks/search", {
          q: query,
          limit: String(Math.min(20, limit * 3)),
          fields: "id,title,artist_display,image_id,is_public_domain,thumbnail",
        }),
        headers: { ...HEADERS, "AIC-User-Agent": HEADERS["User-Agent"] },
        throw: false,
      });
      return parseArtic(jsonOf(res, "Art Institute of Chicago"));
    }
    case "pexels": {
      const res = await requestUrlWithTimeout({
        url: withQuery("https://api.pexels.com/v1/search", { query, per_page: n }),
        headers: { ...HEADERS, Authorization: keys[0] },
        throw: false,
      });
      return parsePexels(jsonOf(res, "Pexels"));
    }
    case "unsplash": {
      const res = await requestUrlWithTimeout({
        url: withQuery("https://api.unsplash.com/search/photos", {
          query,
          per_page: n,
          content_filter: "high",
        }),
        headers: { ...HEADERS, Authorization: `Client-ID ${keys[0]}`, "Accept-Version": "v1" },
        throw: false,
      });
      return parseUnsplash(jsonOf(res, "Unsplash"));
    }
    case "brave": {
      const res = await requestUrlWithTimeout({
        url: withQuery("https://api.search.brave.com/res/v1/images/search", {
          q: query,
          count: n,
          safesearch: "strict",
        }),
        headers: { ...HEADERS, Accept: "application/json", "X-Subscription-Token": keys[0] },
        throw: false,
      });
      // Brave answers a key it does not know with 422.
      if (res.status === 422)
        throw new Error("Brave Search refused the key (422). Check the key in Horme's Images settings.");
      return parseBrave(jsonOf(res, "Brave Search"));
    }
  }
}

/** Unsplash asks to be told when one of its pictures is downloaded. Failures are ignored. */
export async function pingUnsplashDownload(plugin: HormePlugin, url: string): Promise<void> {
  const keys = sourceKeys(plugin, "unsplash");
  if (!keys) return;
  await requestUrlWithTimeout({
    url,
    headers: { ...HEADERS, Authorization: `Client-ID ${keys[0]}`, "Accept-Version": "v1" },
    throw: false,
  }).catch((e: unknown) => plugin.debugWarn("Horme: Unsplash download ping failed.", errorToMessage(e)));
}
