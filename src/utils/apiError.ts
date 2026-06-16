import { RequestUrlResponse } from "obsidian";

/**
 * Pulls a human-readable detail out of a provider error body. Handles the common shapes:
 *   - OpenAI / Groq / OpenRouter / Mistral / LM Studio / Gemini / Claude: `{ error: { message } }`
 *   - Ollama: `{ error: "message" }`
 *   - plain string bodies (e.g. an HTML 502 from a proxy).
 */
function extractDetail(body: unknown): string {
  if (typeof body === "string") return body;
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    const err = obj.error;
    if (typeof err === "string") return err;
    if (err && typeof err === "object") {
      const msg = (err as Record<string, unknown>).message;
      if (typeof msg === "string") return msg;
    }
    if (typeof obj.message === "string") return obj.message;
  }
  return "";
}

function format(status: number, body: unknown): string {
  const detail = extractDetail(body).trim().replace(/\s+/g, " ").slice(0, 300);
  return detail ? `${status} — ${detail}` : `${status}`;
}

/**
 * Builds an error string (`"<status> — <message>"`) from an Obsidian `requestUrl`
 * response. Requires the request to have been made with `throw: false` so the body
 * is available on a non-2xx response.
 */
export function requestUrlError(res: RequestUrlResponse): string {
  let body: unknown;
  try {
    body = res.json;
  } catch {
    body = res.text;
  }
  return format(res.status, body);
}

/**
 * Builds an error string from a `fetch` Response, reading the body text once.
 * Safe to call on the error path of a streaming request (the stream is discarded).
 */
export async function fetchError(res: Response): Promise<string> {
  let body: unknown = "";
  try {
    const text = await res.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  } catch {
    /* body unavailable */
  }
  return format(res.status, body);
}
