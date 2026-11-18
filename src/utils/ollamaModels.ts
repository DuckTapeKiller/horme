/** A model as Ollama lists it (/api/tags). */
export interface OllamaModelTag {
  name: string;
  modified_at?: string;
  details?: { family?: string };
}

/** Embedding models cannot chat: their name or family says so. */
export function isOllamaEmbeddingModel(tag: OllamaModelTag): boolean {
  const name = tag.name.toLowerCase();
  const family = (tag.details?.family ?? "").toLowerCase();
  return name.includes("embed") || family.includes("bert") || family.includes("embed");
}

/**
 * The chat model to use when none is set, or the one set is gone: the same
 * family as before if there is one ("llama3" → "llama3.1:8b"), then a common
 * chat family, then the most recently changed chat model.
 */
export function pickOllamaChatModel(tags: OllamaModelTag[], current: string): string | null {
  const candidates = tags.filter((m) => m.name && !isOllamaEmbeddingModel(m));
  if (candidates.length === 0) return null;
  const byRecency = (a: OllamaModelTag, b: OllamaModelTag) =>
    (Date.parse(b.modified_at ?? "") || 0) - (Date.parse(a.modified_at ?? "") || 0);
  const firstStarting = (prefix: string) => {
    const matches = candidates.filter((m) => m.name.toLowerCase().startsWith(prefix));
    return matches.length ? matches.sort(byRecency)[0].name : null;
  };
  const currentBase = current.trim().split(":")[0].toLowerCase();
  if (currentBase) {
    const same = firstStarting(currentBase);
    if (same) return same;
  }
  for (const family of ["llama3", "llama", "qwen", "gemma", "mistral", "phi", "deepseek", "mixtral"]) {
    const found = firstStarting(family);
    if (found) return found;
  }
  return candidates.sort(byRecency)[0].name;
}
