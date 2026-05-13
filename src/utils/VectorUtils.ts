/**
 * Shared utility for Int8 Quantization of AI embeddings.
 * Maps float [-1, 1] → Int8 [-127, 127] and stores as base64.
 */

function bytesToBase64(bytes: Uint8Array): string {
  const maybeBytes = bytes as Uint8Array & { toBase64?: () => string };
  if (typeof maybeBytes.toBase64 === "function") {
    try {
      return maybeBytes.toBase64();
    } catch {
      // fall through
    }
  }

  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const maybeU8 = Uint8Array as Uint8ArrayConstructor & { fromBase64?: (input: string) => Uint8Array };
  if (typeof maybeU8.fromBase64 === "function") {
    try {
      return maybeU8.fromBase64(b64);
    } catch {
      // fall through
    }
  }

  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function quantizeEmbeddingToInt8(embedding: number[]): Int8Array {
  const int8 = new Int8Array(embedding.length);
  for (let i = 0; i < embedding.length; i++) {
    const clamped = Math.max(-1, Math.min(1, embedding[i]));
    int8[i] = Math.round(clamped * 127);
  }
  return int8;
}

export function compressEmbedding(embedding: number[] | Int8Array): string {
  const int8 = embedding instanceof Int8Array ? embedding : quantizeEmbeddingToInt8(embedding);
  const bytes = new Uint8Array(int8.buffer, int8.byteOffset, int8.byteLength);
  return bytesToBase64(bytes);
}

export function decompressEmbeddingToInt8(b64: string): Int8Array {
  const bytes = base64ToBytes(b64);
  return new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function decompressEmbedding(b64: string): number[] {
  const int8 = decompressEmbeddingToInt8(b64);
  const result = new Array<number>(int8.length);
  for (let i = 0; i < int8.length; i++) {
    result[i] = int8[i] / 127;
  }
  return result;
}

/**
 * Shared cosine similarity calculation.
 * Handles mismatched lengths and zero-vector edge cases.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
    const len = Math.min(a.length, b.length);
    if (len === 0) return 0;

    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < len; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }

    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}

/**
 * Cosine similarity for float query embedding vs. quantized Int8 doc embedding.
 * NOTE: This is mathematically equivalent to using (int8/127) floats because the scale cancels.
 */
export function cosineSimilarityFloatInt8(a: number[], b: Int8Array): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < len; i++) {
    const ai = a[i];
    const bi = b[i];
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Cosine similarity for two quantized Int8 embeddings.
 * NOTE: Scale cancels, so this matches cosine on (int8/127) float vectors.
 */
export function cosineSimilarityInt8(a: Int8Array, b: Int8Array): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < len; i++) {
    const ai = a[i];
    const bi = b[i];
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Returns the correct query/document prefix for the active embedding model.
 */
export function getModelPrefixes(model: string): { query: string; document: string } {
  const m = model.toLowerCase();
  if (m.includes("nomic")) return { query: "search_query: ", document: "search_document: " };
  if (m.includes("mxbai")) return { query: "Represent this sentence for searching relevant passages: ", document: "" };
  return { query: "", document: "" };
}
