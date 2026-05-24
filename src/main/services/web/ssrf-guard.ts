/**
 * Shared SSRF guard for outbound page fetches (web_fetch tool + page extractor).
 *
 * Blocks non-http(s) schemes and any URL whose host is — or DNS-resolves to — a
 * private / loopback / link-local / carrier-NAT / cloud-metadata address.
 *
 * Resolving the host (not just string-matching it) is what closes the three
 * classic bypasses of a string-only guard:
 *   1. a public hostname whose A/AAAA record points at an internal IP,
 *   2. decimal/hex/octal IPv4 encodings (e.g. http://2130706433), which the OS
 *      resolver normalizes to the real address before we inspect it,
 *   3. redirects to internal targets — each hop is re-checked by the callers.
 */
import dns from 'node:dns/promises';

export type UnsafeReason = 'invalid' | 'protocol' | 'private';

export class UnsafeUrlError extends Error {
  constructor(readonly reason: UnsafeReason) {
    super(reason);
    this.name = 'UnsafeUrlError';
  }
}

function isPrivateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;            // link-local + cloud metadata (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
  if (a === 192 && b === 168) return true;            // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT 100.64.0.0/10
  return false;
}

function isPrivateIPv6(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (h === '::1' || h === '::') return true;
  if (h.startsWith('fc') || h.startsWith('fd')) return true;   // ULA fc00::/7
  if (h.startsWith('fe80')) return true;                       // link-local fe80::/10
  if (h.startsWith('::ffff:')) return isPrivateIPv4(h.slice(7)); // IPv4-mapped
  return false;
}

/** True for any loopback/private/link-local/metadata literal IP (v4 or v6). */
export function isPrivateIp(ip: string): boolean {
  return ip.includes(':') ? isPrivateIPv6(ip) : isPrivateIPv4(ip);
}

/** Host suffixes that should never be fetched, independent of DNS. */
function isBlockedHostName(host: string): boolean {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan')
  );
}

function bareHost(url: URL): string {
  let host = url.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return host;
}

/**
 * Synchronous, DNS-free check for use in sync contexts (e.g. Electron
 * `will-redirect`). Catches bad schemes, blocked names, and literal private IPs;
 * cannot catch hostnames that *resolve* to internal IPs — use {@link assertPublicUrl}
 * wherever an async check is possible.
 */
export function isUnsafeUrlSync(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return true;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
  const host = bareHost(url);
  if (isBlockedHostName(host)) return true;
  return host.includes(':') ? isPrivateIPv6(host) : isPrivateIPv4(host);
}

/**
 * Full async guard: scheme + host string + DNS-resolved IPs. Throws
 * {@link UnsafeUrlError} on any unsafe target. Returns the parsed URL on success.
 */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UnsafeUrlError('invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UnsafeUrlError('protocol');

  const host = bareHost(url);
  if (isBlockedHostName(host)) throw new UnsafeUrlError('private');

  if (host.includes(':')) {
    if (isPrivateIPv6(host)) throw new UnsafeUrlError('private');
  } else if (isPrivateIPv4(host)) {
    throw new UnsafeUrlError('private');
  }

  // Resolve the host and reject if ANY returned address is private. This catches
  // public hostnames pointing at internal IPs and non-dotted IPv4 encodings
  // (the OS resolver normalizes 2130706433 / 0x7f000001 to the real address).
  try {
    const records = await dns.lookup(host, { all: true });
    for (const record of records) {
      if (isPrivateIp(record.address)) throw new UnsafeUrlError('private');
    }
  } catch (err) {
    if (err instanceof UnsafeUrlError) throw err;
    // DNS failure (NXDOMAIN, offline, …) is not a private-address signal — let the
    // real fetch surface the network error instead of masking it as "blocked".
  }

  return url;
}
