/**
 * Labels naming the embedding space an index was built in: which server kind
 * and model made the vectors, and for the OpenAI-compatible server which
 * server ("custom:model@http://host/v1"). Vectors from different spaces are
 * never compared.
 */

export interface EmbeddingLabel {
  kind: string;
  model: string;
  address: string;
}

export function parseEmbeddingLabel(label: string): EmbeddingLabel | null {
  const m = /^(ollama|lmstudio|llamacpp|custom):(.*?)(?:@(https?:\/\/.*))?$/.exec(label);
  return m ? { kind: m[1], model: m[2], address: m[3] ?? "" } : null;
}

/**
 * True when an index labelled `stored` can be searched with the set-up
 * labelled `current`: the same server kind and model, and the same address
 * where both name one. An "auto" model is one not known by name, as in labels
 * written before detected models were recorded: it is taken to be the model
 * there now, and the label is rewritten with its name at the next save.
 */
export function sameEmbeddingSpace(stored: string, current: string): boolean {
  if (!stored || stored === current) return true;
  const a = parseEmbeddingLabel(stored);
  const b = parseEmbeddingLabel(current);
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.address && b.address && a.address !== b.address) return false;
  return a.model === b.model || a.model === "auto" || b.model === "auto";
}
