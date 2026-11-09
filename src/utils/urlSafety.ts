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
  // "localhost." and "printer.local." are the same hosts as without the dot.
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
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
    if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
    if (a >= 224) return false; // multicast, reserved, broadcast
    return true;
  }
  if (host.includes(":")) {
    if (host === "::1" || host === "::") return false;
    if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return false;
    // IPv4 inside IPv6: mapped (::ffff:), compatible (::) and NAT64 (64:ff9b::).
    const embedded = /^(?:::ffff:|::|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (embedded) {
      const hi = parseInt(embedded[1], 16);
      const lo = parseInt(embedded[2], 16);
      return isPublicHttpUrl(`http://${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}/`);
    }
  }
  return true;
}
