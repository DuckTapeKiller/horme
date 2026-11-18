/**
 * Fitting a request into a model's context window. Vault Brain sent its 20
 * best passages whatever the model, about 9,600 tokens with Horme's prompt and
 * tools: more than Apple Intelligence's 8,192, so every chat with it failed,
 * and the round after a skill (passages plus the skill's result) overflowed
 * too. Providers that know their model's window say so; the others keep
 * sending everything, as before.
 */

/**
 * Characters per token, counted low so the estimate errs on the safe side:
 * Apple's model counted 3.6 for Horme's prompt, tools and passages.
 */
const CHARS_PER_TOKEN = 3.3;

/**
 * Room kept beside the first round's prompt for the reply: a sixth of the
 * window, at least 1,024 tokens. Skill results need no room here: the round
 * after a skill drops the passages when it must.
 */
export function reserveTokens(window: number): number {
  return Math.max(1024, Math.round(window / 6));
}

/** Room kept for the reply in a round that already holds the skill results. */
export function replyTokens(window: number): number {
  return Math.max(512, Math.round(window / 8));
}

/** Characters left for Vault Brain passages, beside `fixedChars` of everything else in the request. */
export function passageBudget(window: number, fixedChars: number): number {
  return Math.max(0, Math.floor((window - reserveTokens(window)) * CHARS_PER_TOKEN) - fixedChars);
}

/** Characters a round may hold in all, leaving room for the reply. */
export function roundBudget(window: number): number {
  return Math.floor((window - replyTokens(window)) * CHARS_PER_TOKEN);
}

/** The best passages (they come best first) that fit in `budgetChars` with their separators. */
export function fitPassages(passages: string[], budgetChars: number, separator = "\n\n---\n\n"): string[] {
  const out: string[] = [];
  let used = 0;
  for (const p of passages) {
    const cost = p.length + (out.length ? separator.length : 0);
    if (used + cost > budgetChars) break;
    out.push(p);
    used += cost;
  }
  return out;
}

/** Text cut to `maxChars`, at a paragraph or line end when one is near, with a mark that it was cut. */
export function fitText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const mark = "\n\n[…cut to fit the model's context window]";
  const room = Math.max(0, maxChars - mark.length);
  const head = text.slice(0, room);
  const end = Math.max(head.lastIndexOf("\n\n"), head.lastIndexOf("\n"));
  return `${end > room * 0.7 ? head.slice(0, end) : head}${mark}`;
}
