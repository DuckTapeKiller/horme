/**
 * Normalizes a user-entered local server base URL: trims whitespace, strips
 * trailing slashes, and strips a trailing API version segment ("/v1").
 *
 * Users paste URLs both with and without the version suffix (LM Studio's UI
 * shows "http://localhost:1234/v1"), while every call site appends its own
 * "/v1/..." path — so the suffix must never remain in the base. Without this,
 * a saved ".../v1" produced requests to ".../v1/v1/chat/completions".
 */
export function normalizeBaseUrl(url: string): string {
  return url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v\d+$/i, "");
}
