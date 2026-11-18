/**
 * What Vault Brain reads from a note's text: headings, highlights, and a
 * stable hash of each passage. No Obsidian calls, so it is tested directly.
 */

/** Extracts all markdown headings with their character offsets */
export function extractHeadings(content: string): Array<{ level: number; text: string; offset: number }> {
  const headings: Array<{ level: number; text: string; offset: number }> = [];

  // Mask code blocks with spaces to preserve character offsets while hiding comments
  const maskedContent = content.replace(/```[\s\S]*?```/g, (match) => " ".repeat(match.length));

  const regex = /^(#{1,6})\s+(.+)$/gm;
  let match;
  while ((match = regex.exec(maskedContent)) !== null) {
    headings.push({ level: match[1].length, text: match[2].trim(), offset: match.index });
  }
  return headings;
}

/** Returns the heading hierarchy path at a given character offset */
export function headingPathAtOffset(
  headings: Array<{ level: number; text: string; offset: number }>,
  offset: number,
): string {
  const stack: string[] = [];
  const levelStack: number[] = [];
  for (const h of headings) {
    if (h.offset > offset) break;
    while (levelStack.length > 0 && levelStack[levelStack.length - 1] >= h.level) {
      stack.pop();
      levelStack.pop();
    }
    stack.push(h.text);
    levelStack.push(h.level);
  }
  return stack.join(" > ");
}

export function highlightsText(
  content: string,
  limits: { maxHighlights: number; maxChars: number },
): string | null {
  // Ignore frontmatter and code to avoid indexing accidental highlight markers.
  let text = content.replace(/^---\r?\n[\s\S]*?\r?\n---[^\S\r\n]*(?:\r?\n|$)/, "");
  text = text.replace(/```[\s\S]*?```/g, "\n").replace(/~~~[\s\S]*?~~~/g, "\n");
  text = text.replace(/`[^`\n]*`/g, " ");

  const out: string[] = [];
  const seen = new Set<string>();

  // Obsidian highlight syntax: ==highlight==
  const mdRe = /==([^=\n].*?[^=\n])==/g;
  let mdMatch: RegExpExecArray | null;
  while ((mdMatch = mdRe.exec(text)) !== null) {
    const v = mdMatch[1].trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }

  // Highlightr-style HTML marks: <mark ...>highlight</mark>
  const markRe = /<mark\b[^>]*>([\s\S]*?)<\/mark>/gi;
  let markMatch: RegExpExecArray | null;
  while ((markMatch = markRe.exec(text)) !== null) {
    const raw = markMatch[1].replace(/<[^>]+>/g, "").trim();
    if (!raw) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }

  if (out.length === 0) return null;

  const maxCount = Math.max(0, limits.maxHighlights || 0);
  const maxChars = Math.max(0, limits.maxChars || 0);

  const capped = maxCount > 0 ? out.slice(0, maxCount) : [];
  if (capped.length === 0) return null;

  let joined = capped.join("\n");
  if (maxChars > 0 && joined.length > maxChars) {
    joined = joined.slice(0, maxChars);
  }

  return joined.trim() ? joined.trim() : null;
}

export function parseGlobList(raw: string): string[] {
  return raw
    .split(/[,\n]/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Stable, low-collision content hash for chunk-level incremental indexing.
 * Uses two parallel 32-bit FNV-1a accumulators (64-bit effective key) so we
 * can safely reuse embeddings across small edits without relying on BigInt.
 */
export function chunkHash(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let h1 = 0x811c9dc5;
  let h2 = (0x811c9dc5 ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    h1 ^= b;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= b;
    h2 = Math.imul(h2, 0x01000193) >>> 0;
    // Cross-mix to reduce correlated collisions when only seed differs
    h2 ^= (h1 + ((h1 << 7) | (h1 >>> 25))) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}
