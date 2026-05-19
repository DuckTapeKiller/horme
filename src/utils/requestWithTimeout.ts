import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";

/**
 * Wrapper around Obsidian's `requestUrl` that adds timeout support.
 *
 * Obsidian's `RequestUrlParam` interface does not support a `timeout` property.
 * This function uses `Promise.race` against a rejection timer to enforce
 * a maximum wait time for network requests.
 *
 * @param params  Standard Obsidian `RequestUrlParam` options (no `timeout` field).
 * @param timeoutMs  Maximum milliseconds to wait before rejecting. Defaults to 15 000 ms.
 */
export async function requestUrlWithTimeout(
  params: RequestUrlParam,
  timeoutMs = 15000,
): Promise<RequestUrlResponse> {
  return Promise.race([
    requestUrl(params),
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`Network request timed out after ${timeoutMs / 1000}s: ${params.url}`)),
        timeoutMs,
      );
    }),
  ]);
}
