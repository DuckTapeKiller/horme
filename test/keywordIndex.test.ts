import { test } from "node:test";
import assert from "node:assert/strict";
import { KeywordIndex, keywordTokens } from "../src/services/KeywordIndex";

void test("tokens are lower-case, accent-free, without stop words", () => {
  assert.deepEqual(keywordTokens("¿Quién escribió «El Aleph» en 1949?"), ["escribio", "aleph", "1949"]);
  assert.deepEqual(keywordTokens("The Penny Black, 1d."), ["penny", "black", "1d"]);
});

void test("a rare word in the body outranks common words", () => {
  const ix = new KeywordIndex();
  ix.setPath("a.md", [
    { key: "a1", text: "Stamps and auctions. The stamp sold at auction for a high price." },
    { key: "a2", text: "The Treskilling Yellow sold at auction in 1996." },
  ]);
  ix.setPath("b.md", [{ key: "b1", text: "Stamp auction results: stamps, stamps, auction prices." }]);
  const hits = ix.search("Which auction sold the Treskilling Yellow?", 5);
  assert.equal(hits[0].key, "a2");
});

void test("replacing or removing a note updates the index", () => {
  const ix = new KeywordIndex();
  ix.setPath("a.md", [{ key: "a1", text: "Heliotrope code word" }]);
  assert.equal(ix.search("heliotrope", 5).length, 1);
  ix.setPath("a.md", [{ key: "a1", text: "Saffron code word" }]);
  assert.equal(ix.search("heliotrope", 5).length, 0);
  assert.equal(ix.search("saffron", 5).length, 1);
  ix.removePath("a.md");
  assert.equal(ix.size, 0);
  assert.equal(ix.search("saffron", 5).length, 0);
});

void test("results can be limited to allowed passages (search scope)", () => {
  const ix = new KeywordIndex();
  ix.setPath("a.md", [{ key: "a1", text: "Inverted Jenny" }]);
  ix.setPath("b.md", [{ key: "b1", text: "Inverted Jenny" }]);
  assert.deepEqual(
    ix.search("jenny", 5, (k) => k === "b1").map((h) => h.key),
    ["b1"],
  );
});
