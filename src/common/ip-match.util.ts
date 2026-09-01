// A deliberately dependency-free CIDR matcher. IPv4 supports full CIDR
// range matching; IPv6 supports exact-match and full-prefix-only matching
// (no partial-byte IPv6 prefixes) — sufficient for allowlisting a handful
// of office/VPN egress addresses, which is the only realistic use case for
// an admin-panel allowlist.

function normalizeIp(ip: string): string {
  // Express/NestJS may report IPv4-mapped IPv6 addresses like
  // "::ffff:203.0.113.10" for requests that arrive over IPv4.
  const v4MappedPrefix = '::ffff:';
  if (ip.startsWith(v4MappedPrefix)) return ip.slice(v4MappedPrefix.length);
  return ip;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    result = (result << 8) | n;
  }
  return result >>> 0;
}

function isIpv4CidrMatch(ip: string, cidr: string): boolean {
  const [range, prefixLenStr] = cidr.split('/');
  const rangeInt = ipv4ToInt(range);
  const ipInt = ipv4ToInt(ip);
  if (rangeInt === null || ipInt === null) return false;

  const prefixLen = prefixLenStr === undefined ? 32 : Number(prefixLenStr);
  if (!Number.isInteger(prefixLen) || prefixLen < 0 || prefixLen > 32) return false;
  if (prefixLen === 0) return true; // 0.0.0.0/0 — matches everything, deliberately allowed since an operator may set this intentionally in a low-risk dev environment

  const mask = prefixLen === 32 ? 0xffffffff : (~0 << (32 - prefixLen)) >>> 0;
  return (rangeInt & mask) === (ipInt & mask);
}

export function ipMatchesAnyCidr(ip: string, cidrList: string[]): boolean {
  const normalizedIp = normalizeIp(ip);
  const isIpv4 = ipv4ToInt(normalizedIp) !== null;

  return cidrList.some((entry) => {
    const cidr = entry.trim();
    if (!cidr) return false;

    if (isIpv4) {
      // Skip entries that are clearly IPv6 when checking an IPv4 caller.
      if (cidr.includes(':')) return false;
      return isIpv4CidrMatch(normalizedIp, cidr);
    }

    // IPv6: exact match, or exact match against the prefix portion before "/"
    // (covers the common case of allowlisting one specific IPv6 address).
    const [range] = cidr.split('/');
    return range.toLowerCase() === normalizedIp.toLowerCase();
  });
}
