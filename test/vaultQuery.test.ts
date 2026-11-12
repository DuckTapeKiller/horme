import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyFilters,
  countByTag,
  countByTopFolder,
  findNote,
  folderMatches,
  noteLink,
  parseDay,
  phraseMatcher,
  propertyMatches,
  snippet,
  sortNotes,
  tagMatches,
  topicMatcher,
  topicWays,
  type NoteInfo,
} from "../src/utils/vaultQuery";

const day = (s: string) => new Date(`${s}T12:00:00`).getTime();
const note = (path: string, extra: Partial<NoteInfo> = {}): NoteInfo => {
  const parts = path.replace(/\.md$/, "").split("/");
  return {
    path,
    title: parts[parts.length - 1],
    folder: parts.slice(0, -1).join("/"),
    tags: [],
    aliases: [],
    properties: {},
    created: day("2026-01-01"),
    modified: day("2026-01-01"),
    ...extra,
  };
};

const vault: NoteInfo[] = [
  note("1 - COLLECTING DAILY/Stamps/Inverted Jenny.md", { tags: ["stamps/us"], modified: day("2026-11-10") }),
  note("1 - COLLECTING DAILY/The Penny Black stamp.md", { modified: day("2026-11-01") }),
  note("8 - MARKET UPDATES/Stamps market report.md", { properties: { category: "Stamps" } }),
  note("8 - MARKET UPDATES/Coins market report.md", {
    tags: ["coins"],
    properties: { category: "Coins", price: 120 },
  }),
  note("Inbox/Notes on a stampede.md"),
  note("Reading/Sellos de España.md", {
    aliases: ["Spanish stamps"],
    properties: { status: ["reading", "owned"] },
  }),
  note("Untitled.md", { created: day("2026-11-12"), modified: day("2026-11-12") }),
];

void test("a topic finds singular and plural, whole words only, ignoring case and accents", () => {
  const m = topicMatcher("stamps")!;
  assert.equal(m("The Penny Black stamp"), true);
  assert.equal(m("STAMPS market report"), true);
  assert.equal(m("Notes on a stampede"), false);
  assert.equal(topicMatcher("sellos")!("Sellos de España"), true);
  assert.equal(topicMatcher("espana")!("Sellos de España"), true);
  assert.equal(topicMatcher("british stamps")!("Stamps of the British Empire"), true);
  assert.equal(topicMatcher("british stamps")!("British coins"), false);
  assert.equal(topicMatcher("  "), null);
});

void test("how notes are about a topic: title, alias, folder, tag, property", () => {
  const m = topicMatcher("stamps")!;
  const ways = (path: string) => topicWays(vault.find((n) => n.path === path)!, m);
  assert.deepEqual(ways("1 - COLLECTING DAILY/Stamps/Inverted Jenny.md"), ["folder", "tag"]);
  assert.deepEqual(ways("1 - COLLECTING DAILY/The Penny Black stamp.md"), ["title"]);
  assert.deepEqual(ways("8 - MARKET UPDATES/Stamps market report.md"), ["title", "property"]);
  // A "tags" property is a tag match, not a second, property match.
  assert.deepEqual(topicWays(note("A.md", { tags: ["stamps"], properties: { tags: ["stamps"] } }), m), [
    "tag",
  ]);
  // A long excerpt or a web address that mentions the topic is not a property match.
  const coins = note("Coins guide.md", {
    properties: {
      Excerpt:
        "Coins have long been collected alongside stamps, medals and banknotes by generations of collectors.",
      Shopify: "https://www.example.com/blogs/news/coins-and-stamps",
    },
  });
  assert.deepEqual(topicWays(coins, m), []);
  assert.deepEqual(ways("Reading/Sellos de España.md"), ["title"]); // its alias
  assert.deepEqual(ways("Inbox/Notes on a stampede.md"), []);
});

void test("folders match by full path or by any folder's name", () => {
  assert.equal(folderMatches("1 - COLLECTING DAILY/Stamps", "Stamps"), true);
  assert.equal(folderMatches("1 - COLLECTING DAILY/Stamps", "collecting daily"), true);
  assert.equal(folderMatches("1 - COLLECTING DAILY/Stamps", "1 - collecting daily"), true);
  assert.equal(folderMatches("8 - MARKET UPDATES", "Stamps"), false);
  assert.equal(folderMatches("", "Inbox"), false);
});

void test("tags match with or without #, singular or plural, nested tags included", () => {
  assert.equal(tagMatches(["stamps/us"], "#stamps"), true);
  assert.equal(tagMatches(["stamps/us"], "stamp"), true);
  assert.equal(tagMatches(["coins"], "coin"), true);
  assert.equal(tagMatches(["coins"], "stamps"), false);
});

void test("properties match by presence or by value, lists included", () => {
  assert.equal(propertyMatches({ Category: "Stamps" }, "category"), true);
  assert.equal(propertyMatches({ category: "Stamps" }, "category", "stamps"), true);
  assert.equal(propertyMatches({ status: ["reading", "owned"] }, "status", "owned"), true);
  assert.equal(propertyMatches({ price: 120 }, "price", "120"), true);
  assert.equal(propertyMatches({ category: "" }, "category"), false);
  assert.equal(propertyMatches({}, "category"), false);
});

void test("filters combine: folder, tag, property and dates", () => {
  const paths = (f: Parameters<typeof applyFilters>[1]) => applyFilters(vault, f).map((n) => n.title);
  assert.deepEqual(paths({ folder: "MARKET UPDATES" }), ["Stamps market report", "Coins market report"]);
  assert.deepEqual(paths({ folder: "market updates", property: "category", value: "coins" }), [
    "Coins market report",
  ]);
  assert.deepEqual(paths({ tag: "stamps" }), ["Inverted Jenny"]);
  assert.deepEqual(paths({ modifiedAfter: parseDay("2026-11-01") }), [
    "Inverted Jenny",
    "The Penny Black stamp",
    "Untitled",
  ]);
  assert.deepEqual(paths({ modifiedAfter: parseDay("2026-11-01"), modifiedBefore: parseDay("2026-11-12") }), [
    "Inverted Jenny",
    "The Penny Black stamp",
  ]);
  assert.deepEqual(paths({ createdAfter: parseDay("2026-11") }), ["Untitled"]);
});

void test("dates: day, month and year; nonsense is ignored", () => {
  assert.equal(parseDay("2026-11-12"), new Date(2026, 10, 12).getTime());
  assert.equal(parseDay("2026-03"), new Date(2026, 2, 1).getTime());
  assert.equal(parseDay("2026"), new Date(2026, 0, 1).getTime());
  assert.equal(parseDay("last week"), undefined);
  assert.equal(parseDay("2026-13-01"), undefined);
  assert.equal(parseDay(undefined), undefined);
});

void test("a phrase is found in the text, and the line holding it is quoted", () => {
  const m = phraseMatcher("Stanley  Gibbons")!;
  const text = "# Catalogues\n\nThe standard reference is the stanley gibbons catalogue.\nOther line.";
  assert.equal(m(text), true);
  assert.equal(snippet(text, "Stanley  Gibbons"), "The standard reference is the stanley gibbons catalogue.");
  const long = `<p>${"x ".repeat(150)}a catalogue by Stanley Gibbons is the reference ${"y ".repeat(150)}</p>`;
  const quote = snippet(long, "stanley gibbons", 80);
  assert.ok(quote.includes("Stanley Gibbons"), quote);
  assert.ok(!quote.includes("<p>"), quote);
  assert.ok(quote.startsWith("…") && quote.endsWith("…"), quote);
  assert.equal(phraseMatcher("Scott catalogue")!(text), false);
});

void test("a note is found by path, title, alias, or the start of its title; ties are listed", () => {
  assert.equal(findNote(vault, "Inverted Jenny").note?.path, "1 - COLLECTING DAILY/Stamps/Inverted Jenny.md");
  assert.equal(findNote(vault, "[[Inverted Jenny]]").note?.title, "Inverted Jenny");
  assert.equal(findNote(vault, "8 - MARKET UPDATES/Coins market report").note?.title, "Coins market report");
  assert.equal(findNote(vault, "spanish stamps").note?.title, "Sellos de España");
  assert.equal(findNote(vault, "the penny").note?.title, "The Penny Black stamp");
  const tie = findNote(vault, "market report");
  assert.equal(tie.note, undefined);
  assert.equal(tie.candidates.length, 2);
});

void test("counts by folder and tag, sorting, and links", () => {
  assert.deepEqual(countByTopFolder(vault).slice(0, 2), [
    ["1 - COLLECTING DAILY", 2],
    ["8 - MARKET UPDATES", 2],
  ]);
  assert.deepEqual(countByTag(vault), [
    ["coins", 1],
    ["stamps/us", 1],
  ]);
  assert.equal(sortNotes(vault, "modified")[0].title, "Untitled");
  assert.equal(sortNotes(vault, "name")[0].title, "Coins market report");
  assert.equal(noteLink(vault[0]), "[[1 - COLLECTING DAILY/Stamps/Inverted Jenny|Inverted Jenny]]");
  assert.equal(noteLink(vault[6]), "[[Untitled]]");
});
