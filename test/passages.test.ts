import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeDuckDuckGoLink, splitPassages, mapLimit, passageNotePath } from "../src/utils/passages";

void test("DuckDuckGo result links are unwrapped to the real address", () => {
  assert.equal(
    decodeDuckDuckGoLink("//duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FCastrato&rut=abc"),
    "https://en.wikipedia.org/wiki/Castrato",
  );
  assert.equal(decodeDuckDuckGoLink("https://example.com/page"), "https://example.com/page");
  assert.equal(decodeDuckDuckGoLink("javascript:alert(1)"), "");
});

void test("passages keep their section heading and stay near the size asked", () => {
  const text =
    "== Life ==\n" +
    "Abelard taught in Paris. ".repeat(80) +
    "\n== Death ==\nHe died in 1142 at Saint-Marcel.";
  const out = splitPassages(text, 300);
  assert.ok(out.length > 3);
  assert.ok(out[0].startsWith("(Life) "));
  assert.ok(
    out.every((p) => p.length < 600),
    "no passage far over size",
  );
  assert.ok(out.some((p) => p.startsWith("(Death) ") && p.includes("1142")));
});

void test("mapLimit keeps order and never runs more than the limit at once", async () => {
  let running = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12]);
  assert.equal(peak, 2);
});

void test("end-of-article link sections are not passages", () => {
  const out = splitPassages(
    "== Life ==\nAbelard taught in Paris for many years.\n== See also ==\n- List of philosophers\n== References ==\n- Clanchy, M. T. Abelard.",
  );
  assert.equal(out.length, 1);
  assert.ok(out[0].startsWith("(Life) "));
});

void test("passage labels give the whole note path, brackets in the name included", () => {
  assert.equal(passageNotePath("[From Library/The Peregrine.md (Intro)]:\nx"), "Library/The Peregrine.md");
  assert.equal(passageNotePath("[From Library/The Peregrine.md]:\nx"), "Library/The Peregrine.md");
  assert.equal(
    passageNotePath("[From 3 - ARTICLES/JUAN FORN/Napalm Girl (historia de una foto).md (La foto)]:\nx"),
    "3 - ARTICLES/JUAN FORN/Napalm Girl (historia de una foto).md",
  );
  assert.equal(passageNotePath("[From Papers/Report (draft).pdf]:\nx"), "Papers/Report (draft).pdf");
  assert.equal(passageNotePath("no label"), "");
});
