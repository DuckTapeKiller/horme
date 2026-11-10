import { test } from "node:test";
import assert from "node:assert/strict";
import {
  linkCitations,
  mergePills,
  parseResearchSources,
  pillsFromSkillResult,
  sourceLabel,
} from "../src/utils/citations";

const result = `# Research results

## Passages

[1] Something, see https://stars.library.ucf.edu/thesis/1014 for more.

## Sources

[1] Jesuit Missions of Chiquitos — https://en.wikipedia.org/wiki/Jesuit_Missions_of_Chiquitos
[2] Catholic Church and the Age of Discovery — https://en.wikipedia.org/wiki/Catholic_Church_and_the_Age_of_Discovery
[4] Christianity (and colonialism) — https://example.org/a(b)
`;

void test("the sources list of a research result is read by number", () => {
  const map = parseResearchSources(result);
  assert.equal(map.size, 3);
  assert.equal(map.get(2)?.title, "Catholic Church and the Age of Discovery");
  assert.equal(map.get(4)?.url, "https://example.org/a(b)");
});

void test("citations become links, with no source list added to the answer", () => {
  const map = parseResearchSources(result);
  const out = linkCitations("The Jesuits ran reductions [1]. Orders were linked to conquest [2], [4].", map);
  assert.equal(
    out,
    "The Jesuits ran reductions [\\[1\\]](https://en.wikipedia.org/wiki/Jesuit_Missions_of_Chiquitos). " +
      "Orders were linked to conquest [\\[2\\]](https://en.wikipedia.org/wiki/Catholic_Church_and_the_Age_of_Discovery), " +
      "[\\[4\\]](https://example.org/a%28b%29).",
  );
  assert.ok(!/Sources/.test(out));
});

void test("groups and ranges are split; unknown numbers, code and links are left alone", () => {
  const map = parseResearchSources(result);
  const out = linkCitations(
    "A [1, 2]. B [1-2]. C [3]. D `x[1]`. E [see](http://x.y) [[2]] [1](http://z). F [2, 3].",
    map,
  );
  assert.ok(out.startsWith("A [\\[1\\]]("), out);
  assert.equal((out.match(/\[\\\[2\\\]\]\(/g) ?? []).length, 2);
  assert.ok(out.includes("C [3]."));
  assert.ok(out.includes("`x[1]`"));
  assert.ok(out.includes("[[2]]"));
  assert.ok(out.includes("[1](http://z)"));
  assert.ok(out.includes("F [2, 3]."), "a group with an unknown number stays as written");
});

void test("linking twice changes nothing, and no sources means no change", () => {
  const map = parseResearchSources(result);
  const once = linkCitations("Fact [2].", map);
  assert.equal(linkCitations(once, map), once);
  assert.equal(linkCitations("Fact [2].", new Map()), "Fact [2].");
});

void test("sources are named by what they are, not by their host", () => {
  assert.equal(sourceLabel("https://en.wikipedia.org/wiki/Peter_Abelard"), "Wikipedia: Peter Abelard");
  assert.equal(sourceLabel("https://es.wikipedia.org/wiki/Pedro_Abelardo"), "Wikipedia (es): Pedro Abelardo");
  assert.equal(
    sourceLabel("https://en.wikipedia.org/wiki/Category%3ACastrated_people"),
    "Wikipedia: Category:Castrated people",
  );
  assert.equal(sourceLabel("https://en.wiktionary.org/wiki/castrato"), "Wiktionary: castrato");
  assert.equal(
    sourceLabel("https://www.britannica.com/biography/Peter-Abelard"),
    "Britannica: Peter Abelard",
  );
  assert.equal(
    sourceLabel("https://www.historytoday.com/a/b", "Abelard and Heloise | History Today"),
    "historytoday.com: Abelard and Heloise",
  );
  assert.equal(sourceLabel("https://example.com/x"), "example.com");
});

void test("a research result gives numbered pills from its sources list only", () => {
  const pills = pillsFromSkillResult(result);
  assert.deepEqual(
    pills.map((p) => [p.n, p.label]),
    [
      [1, "Wikipedia: Jesuit Missions of Chiquitos"],
      [2, "Wikipedia: Catholic Church and the Age of Discovery"],
      [4, "example.org: Christianity (and colonialism)"],
    ],
  );
});

void test("other results give unnamed or link-text pills, and numbered pills lead", () => {
  const ddg = pillsFromSkillResult(
    "1. **[Abelard - Britannica](https://www.britannica.com/biography/Peter-Abelard)**: text\n<!-- https://en.wikipedia.org/wiki/Heloise -->",
  );
  assert.deepEqual(
    ddg.map((p) => [p.n, p.label]),
    [
      [undefined, "Britannica: Abelard - Britannica"],
      [undefined, "Wikipedia: Heloise"],
    ],
  );
  const merged = mergePills([...ddg], pillsFromSkillResult(result));
  assert.deepEqual(
    merged.map((p) => p.n ?? "-"),
    [1, 2, 4, "-", "-"],
  );
  // A second research result renumbers: the first one's numbers are dropped.
  const again = mergePills(merged, [{ url: "https://x.org/", label: "x.org", n: 1 }]);
  assert.deepEqual(
    again.map((p) => p.n ?? "-"),
    [1, "-", "-", "-", "-", "-"],
  );
});

void test("links inside Markdown emphasis or with brackets in the address come out whole", () => {
  const pills = pillsFromSkillResult(
    "**[Mercury](https://en.wikipedia.org/wiki/Mercury_(planet))** and https://en.wikipedia.org/wiki/Mercury_(planet). See (https://example.com/page).",
  );
  assert.deepEqual(
    pills.map((p) => p.url),
    ["https://en.wikipedia.org/wiki/Mercury_(planet)", "https://example.com/page"],
  );
  assert.equal(pills[0].label, "Wikipedia: Mercury (planet)");
});
