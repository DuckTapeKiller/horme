import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IMAGE_SOURCES,
  defaultImageSources,
  normalizeImageSources,
  openverseLicence,
  parseArtic,
  parseBrave,
  parseMetObject,
  parseMetSearch,
  parseNasa,
  parseOpenverse,
  parsePexels,
  parseUnsplash,
  unsplashLink,
} from "../src/utils/imageSources";

void test("defaults: every source once, Wikimedia first, keyed sources off", () => {
  const d = defaultImageSources();
  assert.deepEqual(
    d.map((s) => s.id),
    IMAGE_SOURCES.map((s) => s.id),
  );
  assert.equal(d[0].id, "wikimedia");
  assert.equal(d[0].enabled, true);
  for (const s of IMAGE_SOURCES)
    if (s.keys.length) assert.equal(d.find((x) => x.id === s.id)?.enabled, false, s.id);
});

void test("a saved source list keeps its order, drops junk, and gains new sources", () => {
  const saved = [
    { id: "nasa", enabled: true },
    { id: "pexels", enabled: true },
    { id: "nasa", enabled: false }, // duplicate
    { id: "flickr", enabled: true }, // unknown
    "junk",
    null,
    { id: "wikimedia", enabled: "yes" }, // not a boolean: off
  ];
  const out = normalizeImageSources(saved);
  assert.deepEqual(out.slice(0, 3), [
    { id: "nasa", enabled: true },
    { id: "pexels", enabled: true },
    { id: "wikimedia", enabled: false },
  ]);
  assert.equal(out.length, IMAGE_SOURCES.length);
  assert.equal(new Set(out.map((s) => s.id)).size, IMAGE_SOURCES.length);
  assert.deepEqual(normalizeImageSources(undefined), defaultImageSources());
  // A new array each time, so the defaults are never edited through settings.
  assert.notEqual(normalizeImageSources(undefined), normalizeImageSources(undefined));
});

// Real answer, trimmed: collectionapi.metmuseum.org/public/collection/v1/objects/436524
const metObject = {
  objectID: 436524,
  isPublicDomain: true,
  primaryImage: "https://images.metmuseum.org/CRDImages/ep/original/DP-41223-001.jpg",
  primaryImageSmall: "https://images.metmuseum.org/CRDImages/ep/web-large/DP-41223-001.jpg",
  title: "Sunflowers",
  objectName: "Painting",
  artistDisplayName: "Vincent van Gogh",
  objectDate: "1887",
  objectURL: "https://www.metmuseum.org/art/collection/search/436524",
};

void test("The Met: a public-domain object with a picture", () => {
  const img = parseMetObject(metObject);
  assert.ok(img);
  assert.equal(img.source, "The Met");
  assert.equal(img.title, "Sunflowers");
  assert.equal(img.author, "Vincent van Gogh, 1887");
  assert.equal(img.licence, "Public domain");
  assert.equal(img.thumbUrl, metObject.primaryImageSmall);
  assert.equal(img.saveUrl, metObject.primaryImage);
  assert.equal(img.pageUrl, metObject.objectURL);
  assert.equal(parseMetObject({ ...metObject, isPublicDomain: false }), null);
  assert.equal(parseMetObject({ ...metObject, primaryImageSmall: "" }), null);
  assert.deepEqual(parseMetSearch({ total: 3, objectIDs: [436524, "x", 480725] }), [436524, 480725]);
  assert.deepEqual(parseMetSearch({ total: 0, objectIDs: null }), []);
});

// Real answer, trimmed: images-api.nasa.gov/search?q=saturn rings&media_type=image
const nasa = {
  collection: {
    items: [
      {
        data: [
          {
            center: "JPL",
            description_508: "Saturn Rings",
            media_type: "image",
            nasa_id: "PIA02241",
            secondary_creator: "NASA/JPL",
            title: "Saturn Rings",
          },
        ],
        links: [
          {
            href: "https://images-assets.nasa.gov/image/PIA02241/PIA02241~small.jpg",
            rel: "alternate",
            width: 640,
            size: 18000,
            height: 290,
          },
          {
            href: "https://images-assets.nasa.gov/image/PIA02241/PIA02241~thumb.jpg",
            rel: "preview",
            width: 640,
            size: 18000,
            height: 290,
          },
          {
            href: "https://images-assets.nasa.gov/image/PIA02241/PIA02241~orig.jpg",
            rel: "canonical",
            height: 800,
            width: 1760,
            size: 89000,
          },
        ],
      },
      {
        data: [{ nasa_id: "BIG", title: "Huge", media_type: "image", center: "GSFC" }],
        links: [
          { href: "https://images-assets.nasa.gov/image/BIG/BIG~thumb.jpg", rel: "preview" },
          {
            href: "https://images-assets.nasa.gov/image/BIG/BIG~orig.tif",
            rel: "canonical",
            size: 400_000_000,
          },
        ],
      },
      { data: [{ nasa_id: "VID", media_type: "video" }], links: [] },
    ],
  },
};

void test("NASA: the shown picture, a saveable original, a credit and the page", () => {
  const out = parseNasa(nasa);
  assert.equal(out.length, 2);
  assert.equal(out[0].thumbUrl, "https://images-assets.nasa.gov/image/PIA02241/PIA02241~small.jpg");
  assert.equal(out[0].saveUrl, "https://images-assets.nasa.gov/image/PIA02241/PIA02241~orig.jpg");
  assert.equal(out[0].pageUrl, "https://images.nasa.gov/details/PIA02241");
  assert.equal(out[0].author, "NASA/JPL");
  assert.equal(out[0].width, 1760);
  // A 400 MB original is never saved; the preview is.
  assert.equal(out[1].saveUrl, "https://images-assets.nasa.gov/image/BIG/BIG~thumb.jpg");
  assert.equal(out[1].author, "NASA GSFC");
});

// Shape from the Art Institute of Chicago API documentation.
const artic = {
  config: { iiif_url: "https://www.artic.edu/iiif/2" },
  data: [
    {
      id: 16568,
      title: "Water Lilies",
      artist_display: "Claude Monet\nFrench, 1840–1926",
      image_id: "3c27b499-af56-f0d5-93b5-a7f2f1ad5813",
      is_public_domain: true,
      thumbnail: { alt_text: "Painting of a pond with water lilies.", width: 3000, height: 2900 },
    },
    { id: 2, title: "Modern", image_id: "abc", is_public_domain: false },
    { id: 3, title: "No picture", image_id: null, is_public_domain: true },
  ],
};

void test("Art Institute of Chicago: public-domain works only, through IIIF", () => {
  const out = parseArtic(artic);
  assert.equal(out.length, 1);
  assert.equal(
    out[0].thumbUrl,
    "https://www.artic.edu/iiif/2/3c27b499-af56-f0d5-93b5-a7f2f1ad5813/full/843,/0/default.jpg",
  );
  assert.equal(out[0].pageUrl, "https://www.artic.edu/artworks/16568");
  assert.equal(out[0].author, "Claude Monet");
  assert.equal(out[0].description, "Painting of a pond with water lilies.");
});

// Shape from the Openverse API documentation.
const openverse = {
  result_count: 2,
  results: [
    {
      id: "4bc43a04-ef46-4544-a0c1-63c63f56e276",
      title: "Colosseum &amp; sky",
      url: "https://live.staticflickr.com/1/2_b.jpg",
      thumbnail: "https://api.openverse.org/v1/images/4bc43a04-ef46-4544-a0c1-63c63f56e276/thumb/",
      creator: "Jane Doe",
      license: "by-sa",
      license_version: "2.0",
      foreign_landing_url: "https://www.flickr.com/photos/jane/2",
      width: 1024,
      height: 683,
    },
    { id: "x", title: "Local", url: "http://192.168.0.2/a.jpg", thumbnail: "", license: "cc0" },
  ],
};

void test("Openverse: licence, creator, thumbnail and landing page", () => {
  const out = parseOpenverse(openverse);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "Colosseum & sky");
  assert.equal(out[0].licence, "CC BY-SA 2.0");
  assert.equal(out[0].thumbUrl, openverse.results[0].thumbnail);
  assert.equal(out[0].saveUrl, openverse.results[0].url);
  assert.equal(openverseLicence("cc0", "1.0"), "CC0");
  assert.equal(openverseLicence("pdm", ""), "Public domain");
  assert.equal(openverseLicence("", ""), "");
});

// Shape from the Pexels API documentation.
const pexels = {
  photos: [
    {
      id: 2014422,
      width: 3024,
      height: 3024,
      url: "https://www.pexels.com/photo/brown-rocks-during-golden-hour-2014422/",
      photographer: "Joey Farina",
      alt: "Brown Rocks During Golden Hour",
      src: {
        original: "https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg",
        large2x:
          "https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?auto=compress&cs=tinysrgb&dpr=2&h=650&w=940",
        large:
          "https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?auto=compress&cs=tinysrgb&h=650&w=940",
        medium:
          "https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?auto=compress&cs=tinysrgb&h=350",
      },
    },
  ],
};

void test("Pexels: credited as Pexels asks", () => {
  const [img] = parsePexels(pexels);
  assert.equal(img.author, "Photo by Joey Farina on Pexels");
  assert.equal(img.title, "Brown Rocks During Golden Hour");
  assert.equal(img.thumbUrl, pexels.photos[0].src.large);
  assert.equal(img.saveUrl, pexels.photos[0].src.large2x);
  assert.equal(img.pageUrl, pexels.photos[0].url);
});

// Shape from the Unsplash API documentation.
const unsplash = {
  results: [
    {
      id: "eOLpJytrbsQ",
      width: 4000,
      height: 3000,
      description: "A man drinking a coffee.",
      alt_description: "man holding a cup",
      urls: {
        regular:
          "https://images.unsplash.com/photo-1416339306562-f3d12fefd36f?ixlib=rb-0.3.5&q=80&fm=jpg&w=1080",
        small:
          "https://images.unsplash.com/photo-1416339306562-f3d12fefd36f?ixlib=rb-0.3.5&q=80&fm=jpg&w=400",
      },
      links: {
        html: "https://unsplash.com/photos/eOLpJytrbsQ",
        download_location: "https://api.unsplash.com/photos/eOLpJytrbsQ/download?ixid=abc",
      },
      user: { name: "Jeff Sheldon" },
    },
  ],
};

void test("Unsplash: credited as Unsplash asks, with referral links and the download notice", () => {
  const [img] = parseUnsplash(unsplash);
  assert.equal(img.author, "Photo by Jeff Sheldon on Unsplash");
  assert.equal(img.pageUrl, "https://unsplash.com/photos/eOLpJytrbsQ?utm_source=horme&utm_medium=referral");
  assert.equal(img.downloadPing, "https://api.unsplash.com/photos/eOLpJytrbsQ/download?ixid=abc");
  assert.equal(img.thumbUrl, unsplash.results[0].urls.small);
  assert.equal(img.saveUrl, unsplash.results[0].urls.regular);
  assert.equal(unsplashLink("nonsense"), "nonsense");
});

// Shape from the Brave Search API documentation.
const brave = {
  results: [
    {
      title: "Colosseum at night - Example Travel",
      url: "https://www.example.com/rome/colosseum",
      source: "example.com",
      thumbnail: {
        src: "https://imgs.search.brave.com/abc/rs:fit:500:0:0/g:ce/aHR0cHM6Ly9leGFtcGxlLmNvbS9hLmpwZw",
      },
      properties: { url: "https://www.example.com/a.jpg", width: 1600, height: 1067 },
    },
    {
      title: "Private",
      url: "https://intranet.local/x",
      thumbnail: { src: "http://10.1.1.1/t.jpg" },
      properties: { url: "http://10.1.1.1/a.jpg" },
    },
  ],
};

void test("Brave Search: shown through Brave's thumbnail, licence marked unknown", () => {
  const out = parseBrave(brave);
  assert.equal(out.length, 1);
  assert.equal(out[0].licence, "Licence unknown");
  assert.equal(out[0].author, "example.com");
  assert.equal(out[0].thumbUrl, brave.results[0].thumbnail.src);
  assert.equal(out[0].saveUrl, "https://www.example.com/a.jpg");
});

void test("answers that are not what was expected give no pictures, never an error", () => {
  for (const parse of [parseOpenverse, parseNasa, parseArtic, parsePexels, parseUnsplash, parseBrave]) {
    assert.deepEqual(parse(null), []);
    assert.deepEqual(parse("<!DOCTYPE html>"), []);
    assert.deepEqual(parse({ results: "x", photos: 3, data: {}, collection: [] }), []);
  }
  assert.equal(parseMetObject(undefined), null);
});
