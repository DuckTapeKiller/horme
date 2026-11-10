/**
 * Whether an answer came from the notes it was given. Small local models do
 * not reliably say "nothing in your vault"; the answer's own specific facts
 * (names, numbers, dates) tell: an answer drawn from the notes repeats theirs.
 */

function fold(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** The specific facts of a text: numbers and capitalised names (not the first word of a sentence). */
export function factTokens(text: string): string[] {
  const out = new Set<string>();
  const body = text.replace(/\[[^\]]*\]\([^)]*\)/g, " ").replace(/https?:\/\/\S+/g, " ");
  for (const m of body.matchAll(/\d[\d.,]*\d|\d/g)) {
    const digits = m[0].replace(/[.,]/g, "");
    if (digits.length >= 2) out.add(digits);
  }
  // Capitalised words, except the first word of a sentence or a line.
  let sentenceStart = true;
  for (const m of body.matchAll(/[\p{L}][\p{L}'’-]*|[.!?:¿¡\n]/gu)) {
    const w = m[0];
    if (/^[.!?:¿¡\n]$/.test(w)) {
      sentenceStart = true;
      continue;
    }
    if (!sentenceStart && w.length >= 3 && /^\p{Lu}/u.test(w)) out.add(fold(w).replace(/[’']s$/, ""));
    sentenceStart = false;
  }
  return [...out];
}

/** Share of the answer's facts found in the source text; null when the answer has too few to judge. */
export function groundedShare(answer: string, sources: string): number | null {
  const facts = factTokens(answer);
  if (facts.length < 2) return null;
  const hay = fold(sources).replace(/(\d)[.,](?=\d)/g, "$1");
  let found = 0;
  for (const f of facts) if (hay.includes(f)) found++;
  return found / facts.length;
}

/** How many of the given facts a text contains. */
export function factsIn(facts: string[], text: string): number {
  const hay = fold(text).replace(/(\d)[.,](?=\d)/g, "$1");
  return facts.filter((f) => hay.includes(f)).length;
}

/**
 * The notes an answer drew on: those whose passages hold the most of its facts
 * (at least half as many as the best one). Notes that only came up in the
 * search are left out. Falls back to the first few when the answer has too few
 * facts to judge.
 */
export function notesUsed(answer: string, passagesByNote: Map<string, string>, fallback: string[]): string[] {
  const facts = factTokens(answer);
  if (facts.length < 2) return fallback.slice(0, 5);
  const scored = [...passagesByNote].map(([path, text]) => ({ path, n: factsIn(facts, text) }));
  const best = Math.max(0, ...scored.map((s) => s.n));
  if (best === 0) return [];
  return scored
    .filter((s) => s.n >= Math.max(1, Math.ceil(best / 2)))
    .sort((a, b) => b.n - a.n)
    .map((s) => s.path);
}
