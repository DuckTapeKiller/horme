/**
 * A BM25 word index over the text of every indexed passage, so the keyword half
 * of Vault Brain's search can find a passage by a word in its body (a name, a
 * date, a price), weighting rare words above common ones. It holds no Obsidian
 * objects and is rebuilt per note as notes change.
 */

const STOP = new Set(
  // English
  (
    "a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its " +
    "me my no not of on or our she so than that the their them then there these they this those to too us was we were what " +
    "when where which who whom whose why will with would you your about after before also any each just more most other " +
    "over such only own same some very " +
    // Spanish
    "al algo como con cual cuando de del desde donde el ella ellas ellos en entre era eran es esa ese eso esta este esto fue " +
    "fueron ha han hasta la las le les lo los mas me mi muy nos o para pero por que quien se sin sobre su sus tambien te tu " +
    "un una unas uno unos y ya qué quién cuál cómo dónde cuándo"
  ).split(" "),
);

/** Lower case, accents removed, split on anything that is not a letter or digit. */
export function keywordTokens(text: string): string[] {
  const norm = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const out: string[] = [];
  for (const t of norm.split(/[^a-z0-9]+/)) {
    if (!t || STOP.has(t)) continue;
    if (t.length < 2 && !/^\d$/.test(t)) continue;
    out.push(t);
  }
  return out;
}

interface Doc {
  path: string;
  length: number;
  tf: Map<string, number>;
}

export class KeywordIndex {
  private docs = new Map<string, Doc>();
  private byPath = new Map<string, Set<string>>();
  private postings = new Map<string, Set<string>>();
  private totalLength = 0;

  get size(): number {
    return this.docs.size;
  }

  /** Replaces every passage of a note with the ones given (key → text). */
  setPath(path: string, passages: Array<{ key: string; text: string }>): void {
    this.removePath(path);
    const keys = new Set<string>();
    for (const { key, text } of passages) {
      const tokens = keywordTokens(text);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      this.docs.set(key, { path, length: tokens.length, tf });
      this.totalLength += tokens.length;
      for (const t of tf.keys()) {
        let set = this.postings.get(t);
        if (!set) this.postings.set(t, (set = new Set()));
        set.add(key);
      }
      keys.add(key);
    }
    this.byPath.set(path, keys);
  }

  removePath(path: string): void {
    const keys = this.byPath.get(path);
    if (!keys) return;
    for (const key of keys) {
      const doc = this.docs.get(key);
      if (!doc) continue;
      this.totalLength -= doc.length;
      for (const t of doc.tf.keys()) {
        const set = this.postings.get(t);
        if (!set) continue;
        set.delete(key);
        if (!set.size) this.postings.delete(t);
      }
      this.docs.delete(key);
    }
    this.byPath.delete(path);
  }

  paths(): string[] {
    return [...this.byPath.keys()];
  }

  /** BM25 scores for the query, best first, limited to keys `allowed` accepts. */
  search(
    query: string,
    limit: number,
    allowed?: (key: string) => boolean,
  ): Array<{ key: string; score: number }> {
    const n = this.docs.size;
    if (!n) return [];
    const avg = this.totalLength / n || 1;
    const k1 = 1.2;
    const b = 0.75;
    const scores = new Map<string, number>();
    for (const term of new Set(keywordTokens(query))) {
      const set = this.postings.get(term);
      if (!set) continue;
      const idf = Math.log(1 + (n - set.size + 0.5) / (set.size + 0.5));
      for (const key of set) {
        if (allowed && !allowed(key)) continue;
        const doc = this.docs.get(key);
        if (!doc) continue;
        const f = doc.tf.get(term) ?? 0;
        const s = idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * doc.length) / avg)));
        scores.set(key, (scores.get(key) ?? 0) + s);
      }
    }
    return [...scores.entries()]
      .map(([key, score]) => ({ key, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
