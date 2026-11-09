/**
 * True for http(s) URLs on the public internet. Loopback, private network,
 * link-local and .local addresses are refused: a prompt-injected model could
 * otherwise make a web skill read local services (an Obsidian REST API, a
 * router page) and pass what it found to a cloud provider.
 */
export function isPublicHttpUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (!host.includes(".") && !host.includes(":")) return false; // single-label names are local

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    return true;
  }
  if (host.includes(":")) {
    if (host === "::1" || host === "::") return false;
    if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return false;
    if (host.startsWith("::ffff:")) return isPublicHttpUrl(`http://${host.slice(7)}/`);
  }
  return true;
}
