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
export function notesUsed(
  answer: string,
  passagesByNote: Map<string, string>,
  fallback: string[],
  question = "",
): string[] {
  const facts = factTokens(answer);
  // Too few facts to tell: the notes named after a word of the question or
  // answer. (The first five sent listed Cervantes and Garcilaso under an
  // answer about «le vi ayer».)
  if (facts.length < 2)
    return fallback.filter((path) => titleNamesQuestion(`${question} ${answer}`, [path])).slice(0, 5);
  const scored = [...passagesByNote].map(([path, text]) => ({ path, n: factsIn(facts, text) }));
  const best = Math.max(0, ...scored.map((s) => s.n));
  if (best === 0) return [];
  return scored
    .filter((s) => s.n >= Math.max(1, Math.ceil(best / 2)))
    .sort((a, b) => b.n - a.n)
    .map((s) => s.path);
}

/**
 * The question asks for a source outside the vault by name ("on Wikipedia",
 * "search the web", a link): "Nothing in your vault on this" is not news then.
 */
export function namesOutsideSource(question: string): boolean {
  return (
    /https?:\/\//i.test(question) ||
    // "Research …", "Investiga …": the user asked for a search outside.
    /^\s*(?:please\s+|por favor,?\s+)?(?:research|investiga|look up|busca)\b/i.test(question) ||
    /\b(?:wikipedia|wiktionary|wikcionario|wikimedia|commons|duckduckgo|britannica|google|internet|online|the web|web search|en la web|en la red|deep research)\b/i.test(
      question,
    )
  );
}

/** Words too common to tie a note's title to a question. */
const COMMON = new Set(
  (
    "about which where there their these those would could should after before other under between during while being since until " +
    "notes vault chapter something anything everything cuando donde sobre entre desde hasta porque tiene tienen puede pueden tambien " +
    "estos estas otros otras todos todas mucho muchos habia hacer siendo segun notas capitulo"
  ).split(" "),
);

/**
 * Whether a note sent with the question is named after a word of it
 * ("Wiki — Titivillus" for "what did Titivillus do"): the vault holds the
 * subject, whatever language the note is written in, so "nothing in your
 * vault" would be false. (The fact check compares the answer's words with the
 * note's, and an English answer shares few with a Spanish note.)
 */
export function titleNamesQuestion(question: string, notePaths: string[]): boolean {
  const asked = new Set((fold(question).match(/\p{L}{5,}/gu) ?? []).filter((w) => !COMMON.has(w)));
  if (!asked.size) return false;
  return notePaths.some((path) => {
    const title = fold((path.split("/").pop() ?? path).replace(/\.md$/i, ""));
    return (title.match(/\p{L}{5,}/gu) ?? []).some((w) => asked.has(w));
  });
}
