import { requestUrl } from "obsidian";
import { fetchError, requestUrlError } from "../utils/apiError";
import { asArray, getRecordProp, getStringProp } from "../utils/TypeGuards";

/**
 * The request and reply shapes every server speaking OpenAI's chat
 * completions API shares: cloud services, llama.cpp, LM Studio and the
 * OpenAI-compatible server. `label` names the server in error messages.
 */

/** A message as the chat completions API takes it. */
export type ApiMessage = { role: string; content: string };

/** The reply text of a chat completion: the first choice's message. */
export function replyText(json: unknown): string {
  const choices = asArray(getRecordProp(json, "choices")) ?? [];
  const message = getRecordProp(choices[0], "message");
  return getStringProp(message, "content") ?? "";
}

/** One chat completion, not streamed, through Obsidian's requestUrl (no CORS rules). */
export async function completeChat(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  label: string,
): Promise<string> {
  const res = await requestUrl({
    url,
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ ...body, stream: false }),
    throw: false,
  });
  if (res.status !== 200) throw new Error(`${label} error: ${requestUrlError(res)}`);
  return replyText(res.json as unknown);
}

/** A streamed chat completion fetched by the browser: cloud services, which allow Obsidian's origin. */
export async function streamChat(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  label: string,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const res = await window.fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });
  if (!res.ok) throw new Error(`${label} stream error: ${await fetchError(res)}`);
  if (!res.body) throw new Error(`${label}: no response body`);
  return res.body.getReader();
}
