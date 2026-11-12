import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FoundImage,
  cleanAuthor,
  htmlToText,
  imageBlock,
  imageFileName,
  imageFromInfo,
  imagesFromSkillResult,
  imagesToMarkdown,
  isAllowedImageUrl,
  isWikimediaImageUrl,
  extensionForType,
  withoutImageData,
  withoutTracking,
} from "../src/utils/images";
import { pillsFromSkillResult, sourceLabel } from "../src/utils/citations";

// The shape Wikimedia answers with (formatversion=2), trimmed.
const colosseumPage = {
  pageid: 95579199,
  ns: 6,
  title: "File:Colosseo 2020.jpg",
  imageinfo: [
    {
      size: 69629276,
      width: 12051,
      height: 8442,
      thumburl:
        "https://thumb.wikimedia.org/wikipedia/commons/thumb/d/de/Colosseo_2020.jpg/960px-Colosseo_2020.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail",
      responsiveUrls: {
        "2": "https://thumb.wikimedia.org/wikipedia/commons/thumb/d/de/Colosseo_2020.jpg/1920px-Colosseo_2020.jpg?utm_source=commons.wikimedia.org",
      },
      url: "https://upload.wikimedia.org/wikipedia/commons/d/de/Colosseo_2020.jpg?utm_source=commons.wikimedia.org",
      descriptionurl: "https://commons.wikimedia.org/wiki/File:Colosseo_2020.jpg",
      mime: "image/jpeg",
      extmetadata: {
        ObjectName: { value: "Colosseo 2020" },
        ImageDescription: {
          value: "The <b>Colosseum</b> at dawn &amp; the Arch of Constantine&#39;s shadow",
        },
        Artist: {
          value: '<a href="//commons.wikimedia.org/wiki/User:Diliff" title="User:Diliff">Diliff</a>',
        },
        LicenseShortName: { value: "CC BY-SA 4.0" },
      },
    },
  ],
};

/** A deep copy that keeps the fixture's type. */
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

void test("a Wikimedia file entry becomes an image with thumbnail, credit and page", () => {
  const img = imageFromInfo(colosseumPage);
  assert.ok(img);
  assert.equal(img.title, "Colosseo 2020");
  assert.equal(img.source, "Wikimedia Commons");
  assert.equal(
    img.thumbUrl,
    "https://thumb.wikimedia.org/wikipedia/commons/thumb/d/de/Colosseo_2020.jpg/960px-Colosseo_2020.jpg",
  );
  assert.equal(
    img.saveUrl,
    "https://thumb.wikimedia.org/wikipedia/commons/thumb/d/de/Colosseo_2020.jpg/1920px-Colosseo_2020.jpg",
  );
  assert.equal(img.pageUrl, "https://commons.wikimedia.org/wiki/File:Colosseo_2020.jpg");
  assert.equal(img.author, "Diliff");
  assert.equal(img.licence, "CC BY-SA 4.0");
  assert.equal(img.description, "The Colosseum at dawn & the Arch of Constantine's shadow");
  assert.equal(img.width, 12051);
});

void test("the original file is never used, only thumbnails", () => {
  const img = imageFromInfo(colosseumPage);
  assert.ok(img && !img.thumbUrl.includes("upload.wikimedia.org/wikipedia/commons/d/de/"));
  assert.ok(img && !img.saveUrl.endsWith("/Colosseo_2020.jpg"));
});

void test("files that are not pictures, or not on Wikimedia, are left out", () => {
  const video = clone(colosseumPage);
  video.imageinfo[0].mime = "video/webm";
  assert.equal(imageFromInfo(video), null);
  const pdf = clone(colosseumPage);
  pdf.imageinfo[0].mime = "application/pdf";
  assert.equal(imageFromInfo(pdf), null);
  const elsewhere = clone(colosseumPage);
  elsewhere.imageinfo[0].thumburl = "https://example.com/x.jpg";
  assert.equal(imageFromInfo(elsewhere), null);
  assert.equal(imageFromInfo({ title: "File:x.jpg" }), null);
  assert.equal(imageFromInfo(null), null);
});

void test("without an object name the title is the file name; long descriptions are cut", () => {
  const page = clone(colosseumPage) as unknown as {
    title: string;
    imageinfo: Array<{ extmetadata: Record<string, { value: string } | undefined> }>;
  };
  page.title = "File:Colosseum in Rome, Italy - April 2007.jpg";
  page.imageinfo[0].extmetadata.ObjectName = undefined;
  page.imageinfo[0].extmetadata.ImageDescription = { value: "x".repeat(400) };
  const img = imageFromInfo(page);
  assert.ok(img);
  assert.equal(img.title, "Colosseum in Rome, Italy - April 2007");
  assert.equal(img.description.length, 238);
  assert.ok(img.description.endsWith("…"));
});

void test("only Wikimedia's image servers count as image addresses", () => {
  assert.equal(isWikimediaImageUrl("https://upload.wikimedia.org/wikipedia/commons/a/ab/X.jpg"), true);
  assert.equal(
    isWikimediaImageUrl("https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/X.jpg/960px-X.jpg"),
    true,
  );
  for (const u of [
    "http://upload.wikimedia.org/x.jpg",
    "https://upload.wikimedia.org.evil.com/x.jpg",
    "https://localhost/x.jpg",
    "javascript:alert(1)",
    "data:image/png;base64,AAAA",
    "not a url",
  ])
    assert.equal(isWikimediaImageUrl(u), false, u);
});

void test("tracking parameters are dropped, others kept", () => {
  assert.equal(
    withoutTracking("https://a.org/x.jpg?utm_source=s&utm_campaign=c&lang=en"),
    "https://a.org/x.jpg?lang=en",
  );
  assert.equal(withoutTracking("nonsense"), "nonsense");
});

void test("hidden machine data in artwork titles is dropped", () => {
  // From File:Van Gogh - Starry Night - Google Art Project.jpg, shortened to three languages.
  const objectName =
    '<div class="fn">\n<div style="font-weight:bold;display:inline-block;"><div style="display:inline-block" dir="ltr" lang="en"><i><a href="https://en.wikipedia.org/wiki/The_Starry_Night" class="extiw" title="en:The Starry Night">The Starry Night</a></i></div></div><div style="display: none;">title QS:P1476,en:"<a href="https://en.wikipedia.org/wiki/The_Starry_Night" class="extiw" title="en:The Starry Night">The Starry Night</a>"</div><div style="display: none;">label QS:Les,"<a href="https://es.wikipedia.org/wiki/La_noche_estrellada" class="extiw" title="es:La noche estrellada">La noche estrellada</a>"</div><div style="display:none">label QS:Lzh,"<a href="https://zh.wikipedia.org/wiki/%E6%98%9F%E5%A4%9C">星夜</a>"</div></div>';
  assert.equal(htmlToText(objectName), "The Starry Night");
  assert.equal(htmlToText('<span style="display:none">hidden</span>Shown'), "Shown");
});

void test("uploaders named by their user pages are given by name", () => {
  assert.equal(cleanAuthor("it:Utente:Andtofa User:Andtofa"), "Andtofa");
  assert.equal(cleanAuthor("User:Diliff"), "Diliff");
  assert.equal(cleanAuthor("Vincent van Gogh"), "Vincent van Gogh");
  assert.equal(cleanAuthor("Photo by es:Usuario:Ana (es:Usuario:Ana)"), "Photo by Ana (Ana)");
});

void test("HTML in metadata becomes plain text", () => {
  assert.equal(
    htmlToText("<span>Own&nbsp;work</span> by <i>Ana</i> &amp; Bob &#x263A; &#9731;"),
    "Own work by Ana & Bob ☺ ☃",
  );
  assert.equal(htmlToText("line<br/>break"), "line break");
  assert.equal(htmlToText("&bogus; stays"), "&bogus; stays");
});

const sample: FoundImage[] = [
  {
    source: "Wikimedia Commons",
    title: "Coliseo — «Roma» --> 2020",
    thumbUrl: "https://thumb.wikimedia.org/wikipedia/commons/thumb/d/de/C.jpg/960px-C.jpg",
    saveUrl: "https://thumb.wikimedia.org/wikipedia/commons/thumb/d/de/C.jpg/1920px-C.jpg",
    pageUrl: "https://commons.wikimedia.org/wiki/File:C.jpg",
    author: "José Pérez",
    licence: "CC BY-SA 4.0",
    description: "Vista nocturna",
    width: 4000,
    height: 3000,
  },
];

void test("the hidden block carries images through the result text unchanged", () => {
  const text = `## Images: Coliseo\n\n1. Coliseo\n\n${imageBlock(sample)}`;
  assert.deepEqual(imagesFromSkillResult(text), sample);
  // "-->" in a title cannot end the HTML comment early.
  assert.equal((text.match(/-->/g) ?? []).length, 1);
});

void test("a block with local, plain-http or script addresses is filtered on reading", () => {
  const bad = [
    { ...sample[0], thumbUrl: "http://127.0.0.1:8080/x.jpg" },
    { ...sample[0], thumbUrl: "https://localhost/x.jpg" },
    { ...sample[0], thumbUrl: "javascript:alert(1)" },
    {
      ...sample[0],
      pageUrl: "http://evil.example/x",
      saveUrl: "https://192.168.1.10/y.jpg",
      downloadPing: "http://x",
    },
    { ...sample[0], source: "", thumbUrl: "https://images.pexels.com/photos/1/p.jpeg" },
  ];
  const read = imagesFromSkillResult(imageBlock(bad));
  assert.equal(read.length, 2);
  assert.equal(read[0].pageUrl, "");
  assert.equal(read[0].saveUrl, read[0].thumbUrl);
  assert.equal(read[0].downloadPing, undefined);
  // Blocks written before sources existed came from Wikimedia.
  assert.equal(read[1].source, "Wikimedia Commons");
  assert.deepEqual(imagesFromSkillResult("<!-- horme-images:!!!notbase64 -->"), []);
  assert.deepEqual(imagesFromSkillResult("no block here"), []);
});

void test("pictures are allowed only from public https addresses", () => {
  assert.equal(isAllowedImageUrl("https://images.unsplash.com/photo-1?w=1080"), true);
  assert.equal(isAllowedImageUrl("https://thumb.wikimedia.org/x/960px-y.jpg"), true);
  for (const u of [
    "http://images.pexels.com/x.jpg",
    "https://localhost/x.jpg",
    "https://10.0.0.2/x.jpg",
    "file:///etc/passwd",
    "data:image/png;base64,AA",
  ])
    assert.equal(isAllowedImageUrl(u), false, u);
});

void test("the saved file takes its extension from the content type when known", () => {
  assert.equal(extensionForType("image/png"), "png");
  assert.equal(extensionForType("image/jpeg; charset=binary"), "jpg");
  assert.equal(extensionForType("text/html"), undefined);
  assert.equal(
    imageFileName({ title: "Fox", saveUrl: "https://images.unsplash.com/photo-1?fm=jpg" }, "webp"),
    "Fox.webp",
  );
  assert.equal(
    imageFileName({ title: "Fox", saveUrl: "https://images.unsplash.com/photo-1?fm=jpg" }),
    "Fox.jpg",
  );
});

void test("the model reads the result without the hidden image data", () => {
  const text = `## Images: Coliseo\n\n1. Coliseo\n\n<!-- For the assistant: shown. -->\n${imageBlock(sample)}`;
  const forModel = withoutImageData(text);
  assert.ok(!forModel.includes("horme-images"));
  assert.ok(!forModel.includes("thumb.wikimedia.org"));
  assert.ok(forModel.includes("For the assistant"));
  assert.equal(withoutImageData("plain text"), "plain text");
});

void test("pills come from the file pages, never from the picture addresses", () => {
  const text = `## Images: Coliseo\n\n1. [Coliseo](https://commons.wikimedia.org/wiki/File:C.jpg) — José Pérez · CC BY-SA 4.0\n\n${imageBlock(sample)}`;
  const pills = pillsFromSkillResult(text);
  assert.deepEqual(
    pills.map((p) => p.url),
    ["https://commons.wikimedia.org/wiki/File:C.jpg"],
  );
  assert.equal(pills[0].label, "Wikimedia Commons: Coliseo");
  assert.equal(
    sourceLabel("https://commons.wikimedia.org/wiki/File:Colosseo_2020.jpg"),
    "Wikimedia Commons: Colosseo 2020",
  );
});

void test("saved pictures get a safe file name with the right extension", () => {
  assert.equal(imageFileName(sample[0]), "Coliseo — «Roma» -- 2020.jpg");
  assert.equal(
    imageFileName({
      title: 'a/b:c*d?"e<f>g|h#i^[j].png',
      saveUrl: "https://thumb.wikimedia.org/x/960px-Y.png",
    }),
    "a b c d e f g h i j.png",
  );
  assert.equal(
    imageFileName({ title: "", saveUrl: "https://thumb.wikimedia.org/x/960px-Y.JPEG" }),
    "Image.jpg",
  );
  assert.equal(
    imageFileName({ title: "Map.svg", saveUrl: "https://thumb.wikimedia.org/x/960px-Map.svg.png" }),
    "Map.png",
  );
});

void test("saved conversations show the pictures as Markdown with their credit", () => {
  assert.equal(
    imagesToMarkdown(sample),
    "![Coliseo — «Roma» --> 2020](https://thumb.wikimedia.org/wikipedia/commons/thumb/d/de/C.jpg/960px-C.jpg)\n*José Pérez · CC BY-SA 4.0*",
  );
});
