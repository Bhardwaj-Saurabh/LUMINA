/**
 * fetch_page URL vetting — ARCHITECTURE.md §5 guardrail #4. http/https only, no
 * credentials, no private/loopback/link-local/metadata addresses in IPv4 or IPv6.
 * Hostnames resolve through an injected resolver; ANY private address rejects, and the
 * returned public address is what the caller pins the connection to (rebinding defense).
 */

export interface VettedUrl {
  url: string;
  address: string;
}

// URL serializes IPv4-mapped IPv6 as hex hextets (::ffff:7f00:1); resolvers may hand
// back the dotted form (::ffff:127.0.0.1). Normalize both to octets for the IPv4 rules.
const DOTTED_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;
const HEX_MAPPED = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;

function ipv4Octets(address: string): number[] | undefined {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) return undefined;
  const octets = address.split('.').map(Number);
  return octets.every((o) => o <= 255) ? octets : undefined;
}

function isPrivateIpv4(octets: number[]): boolean {
  const [a, b] = octets as [number, number];
  return (
    a === 0 || // 0.0.0.0/8 "this network"
    a === 10 ||
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local, incl. GCP metadata 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIpv6(address: string): boolean {
  const ip = address.toLowerCase();
  if (ip === '::' || ip === '::1') return true; // unspecified, loopback
  const dotted = DOTTED_MAPPED.exec(ip);
  if (dotted) {
    const octets = ipv4Octets(dotted[1]!);
    return octets === undefined || isPrivateIpv4(octets);
  }
  const hex = HEX_MAPPED.exec(ip);
  if (hex) {
    const [hi, lo] = [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16)];
    return isPrivateIpv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  }
  const first = /^([0-9a-f]{1,4}):/.exec(ip);
  // fe80::/10 link-local
  return first !== null && (parseInt(first[1]!, 16) & 0xffc0) === 0xfe80;
}

function isPrivateAddress(address: string): boolean {
  const octets = ipv4Octets(address);
  if (octets) return isPrivateIpv4(octets);
  if (address.includes(':')) return isPrivateIpv6(address);
  return true; // not a recognizable IP literal — refuse rather than guess
}

export async function vetUrl(
  url: string,
  resolve: (host: string) => Promise<string[]>
): Promise<VettedUrl> {
  const parsed = new URL(url); // throws on garbage — that rejection is the point
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`ssrf: scheme ${parsed.protocol} refused (http/https only)`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('ssrf: credentials in URL refused');
  }

  // Bracketed IPv6 hostnames come back with brackets — strip for range checks.
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (ipv4Octets(host) || host.includes(':')) {
    if (isPrivateAddress(host)) throw new Error(`ssrf: private/reserved address ${host} refused`);
    return { url, address: host };
  }

  const addresses = await resolve(host);
  if (addresses.length === 0) throw new Error(`ssrf: ${host} resolved to no addresses`);
  const bad = addresses.find(isPrivateAddress);
  if (bad !== undefined) {
    throw new Error(`ssrf: ${host} resolves to private/reserved address ${bad}`);
  }
  return { url, address: addresses[0]! };
}
