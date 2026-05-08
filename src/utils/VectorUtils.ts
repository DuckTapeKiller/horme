/**
 * Shared utility for Int8 Quantization of AI embeddings.
 * Maps float [-1, 1] → Int8 [-127, 127] and stores as base64.
 */

export function compressEmbedding(embedding: number[]): string {
    const int8 = new Int8Array(embedding.length);
    for (let i = 0; i < embedding.length; i++) {
        const clamped = Math.max(-1, Math.min(1, embedding[i]));
        int8[i] = Math.round(clamped * 127);
    }
    const bytes = new Uint8Array(int8.buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

export function decompressEmbedding(b64: string): number[] {
    const binary = atob(b64);
    const uint8 = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        uint8[i] = binary.charCodeAt(i);
    }
    const int8 = new Int8Array(uint8.buffer);
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
