import { requestUrl } from "obsidian";
import { asArray, getRecordProp, getStringProp } from "./TypeGuards";

/**
 * CORS-proof streaming for local OpenAI-compatible servers (LM Studio).
 *
 * Obsidian's renderer origin is app://obsidian.md, and LM Studio ships with
 * CORS disabled, so a plain `fetch` fails its preflight before the request
 * ever reaches the server. Obsidian's `requestUrl` bypasses CORS but cannot
 * stream. This helper tries, in order:
 *
 *   1. Node's http/https module (desktop only) — CORS-exempt, true streaming.
 *   2. `fetch` — works when the server has CORS enabled (or a permissive one).
 *   3. `requestUrl` without streaming — CORS-exempt last resort; the full
 *      answer is synthesized into a single streaming-shaped chunk so the
 *      chat parser renders it unchanged (degraded to non-streaming, mobile).
 */

type RequireFn = (id: string) => unknown;

interface MinimalIncomingMessage {
  statusCode?: number;
  on(event: "data", listener: (chunk: Uint8Array) => void): this;
  on(event: "end", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  destroy(): void;
}

interface MinimalClientRequest {
  on(event: "error", listener: (error: Error) => void): this;
  write(data: string): void;
  end(): void;
  destroy(): void;
}

interface MinimalHttpModule {
  request(
    url: string,
    options: { method: string; headers: Record<string, string> },
    callback: (res: MinimalIncomingMessage) => void,
  ): MinimalClientRequest;
}

function getNodeRequire(): RequireFn | null {
  const w = window as unknown as { require?: RequireFn };
  return typeof w.require === "function" ? w.require : null;
}

function getNodeHttpModule(url: string): MinimalHttpModule | null {
  const nodeRequire = getNodeRequire();
  if (!nodeRequire) return null;
  try {
    const moduleName = url.startsWith("https:") ? "https" : "http";
    return nodeRequire(moduleName) as MinimalHttpModule;
  } catch {
    return null;
  }
}

function nodeHttpStream(
  httpModule: MinimalHttpModule,
  url: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const req = httpModule.request(
      url,
      { method: "POST", headers: { "Content-Type": "application/json" } },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status !== 200) {
          const decoder = new TextDecoder();
          let errorBody = "";
          res.on("data", (chunk) => {
            errorBody += decoder.decode(chunk, { stream: true });
          });
          res.on("end", () => {
            reject(new Error(`Local server error (${status}): ${errorBody.slice(0, 300)}`));
          });
          return;
        }
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            res.on("data", (chunk) => {
              try {
                controller.enqueue(chunk);
              } catch {
                res.destroy();
              }
            });
            res.on("end", () => {
              try {
                controller.close();
              } catch {
                // Already closed/errored — nothing to do.
              }
            });
            res.on("error", (error) => {
              try {
                controller.error(error);
              } catch {
                // Already closed — nothing to do.
              }
            });
          },
          cancel() {
            res.destroy();
          },
        });
        resolve(stream.getReader());
      },
    );
    req.on("error", reject);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          req.destroy();
          reject(new DOMException("The operation was aborted.", "AbortError"));
        },
        { once: true },
      );
    }
    req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Non-streaming last resort via requestUrl (CORS-exempt everywhere). The full
 * OpenAI-shape response is converted into ONE streaming-shaped chunk (delta
 * content plus indexed tool_call fragments) so downstream parsing is uniform.
 */
async function requestUrlPseudoStream(
  url: string,
  body: Record<string, unknown>,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const res = await requestUrl({
    url,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, stream: false }),
    throw: false,
  });
  if (res.status !== 200) {
    const detail = typeof res.text === "string" ? res.text.slice(0, 300) : "";
    throw new Error(`Local server error (${res.status})${detail ? `: ${detail}` : ""}`);
  }
  const json: unknown = res.json;
  const choices = asArray(getRecordProp(json, "choices")) ?? [];
  const message = getRecordProp(choices[0], "message");
  const content = getStringProp(message, "content") ?? "";
  const reasoning = getStringProp(message, "reasoning_content") ?? getStringProp(message, "reasoning") ?? "";
  const toolCalls = asArray(getRecordProp(message, "tool_calls")) ?? [];
  const delta: Record<string, unknown> = {};
  if (content) delta.content = content;
  if (reasoning) delta.reasoning_content = reasoning;
  if (toolCalls.length) {
    delta.tool_calls = toolCalls.map((call, index) => {
      const record = call && typeof call === "object" ? (call as Record<string, unknown>) : {};
      return { index, ...record };
    });
  }
  const chunk = new TextEncoder().encode(JSON.stringify({ choices: [{ delta }] }));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk);
      controller.close();
    },
  }).getReader();
}

export async function streamOpenAiCompatible(
  url: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const httpModule = getNodeHttpModule(url);
  if (httpModule) {
    return nodeHttpStream(httpModule, url, body, signal);
  }
  try {
    // eslint-disable-next-line no-restricted-globals -- requestUrl cannot stream
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new Error(`Local server error (${res.status})${detail ? `: ${detail}` : ""}`);
    }
    if (!res.body) throw new Error("Local server returned no response body.");
    return res.body.getReader();
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    // fetch throws TypeError on CORS/network-layer blocks before the request
    // reaches the server; requestUrl is CORS-exempt but cannot stream.
    if (e instanceof TypeError) {
      return requestUrlPseudoStream(url, body);
    }
    throw e;
  }
}
