import { test } from "node:test";
import assert from "node:assert";
import {
  chunkHash,
  extractHeadings,
  headingPathAtOffset,
  highlightsText,
  parseGlobList,
} from "../src/utils/noteText";

const note =
  "---\ntags: [a]\n---\n# Book\n\nIntro ==first idea== here.\n\n## Part one\n\nText with ==second idea== and `==code==`.\n\n### Detail\n\nMore ==first idea==.\n";

void test("headings and the heading path at a position", () => {
  const h = extractHeadings(note);
  assert.deepStrictEqual(
    h.map((x) => [x.level, x.text]),
    [
      [1, "Book"],
      [2, "Part one"],
      [3, "Detail"],
    ],
  );
  assert.strictEqual(headingPathAtOffset(h, note.indexOf("More")), "Book > Part one > Detail");
  assert.strictEqual(headingPathAtOffset(h, note.indexOf("Intro")), "Book");
});

void test("highlights: each once, never from code or frontmatter, within the limits", () => {
  const out = highlightsText(note, { maxHighlights: 10, maxChars: 1000 }) ?? "";
  assert.match(out, /first idea/);
  assert.match(out, /second idea/);
  assert.doesNotMatch(out, /code/);
  assert.strictEqual(out.match(/first idea/g)?.length, 1);
  assert.strictEqual(
    (highlightsText(note, { maxHighlights: 1, maxChars: 1000 }) ?? "").includes("second idea"),
    false,
  );
  assert.strictEqual(highlightsText("No marks here.", { maxHighlights: 10, maxChars: 1000 }), null);
});

void test("glob lists and passage hashes", () => {
  assert.deepStrictEqual(parseGlobList("Music/**, Books/*.md\nTemplates/**"), [
    "Music/**",
    "Books/*.md",
    "Templates/**",
  ]);
  assert.strictEqual(chunkHash("same text"), chunkHash("same text"));
  assert.notStrictEqual(chunkHash("same text"), chunkHash("same text."));
  assert.match(chunkHash("ñandú"), /^[0-9a-f]{16}$/);
});
