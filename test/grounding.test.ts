import { test } from "node:test";
import assert from "node:assert/strict";
import { factTokens, groundedShare, notesUsed } from "../src/utils/grounding";

void test("facts are numbers and names, not sentence openers", () => {
  const f = factTokens("The Penny Black was issued on 1 May 1840 by Rowland Hill. It cost 1d.");
  assert.ok(f.includes("1840") && f.includes("rowland") && f.includes("hill") && f.includes("penny"));
  assert.ok(!f.includes("the") && !f.includes("it"));
});

void test("an answer from the notes is grounded; one from elsewhere is not", () => {
  const notes =
    "Amazing Fantasy #15 (1962): the cover was pencilled by Jack Kirby and inked by Steve Ditko. It sold for $3.6 million.";
  assert.ok(
    (groundedShare("Jack Kirby pencilled it; Steve Ditko inked it. A copy sold for $3,6 million.", notes) ??
      0) >= 0.75,
  );
  assert.ok(
    (groundedShare(
      "The capital of Australia is Canberra, founded in 1913 by Walter Burley Griffin.",
      notes,
    ) ?? 1) < 0.3,
  );
  assert.equal(groundedShare("Yes.", notes), null);
});

void test("only the notes holding the answer's facts are listed", () => {
  const notes = new Map([
    [
      "Library/The Peregrine.md",
      "The Peregrine by J. A. Baker, published in 1967, won the Duff Cooper Prize.",
    ],
    ["Juan Forn/El hilo.md", "Una columna sobre otra cosa, escrita en 1967 en Buenos Aires."],
    ["Dashboard.md", "Tasks and links."],
  ]);
  assert.deepEqual(notesUsed("The Peregrine was written by J A Baker and published in 1967.", notes, []), [
    "Library/The Peregrine.md",
  ]);
  assert.deepEqual(notesUsed("Yes.", notes, ["a", "b"]), ["a", "b"]);
});
