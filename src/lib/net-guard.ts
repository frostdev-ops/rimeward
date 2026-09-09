import dns from 'node:dns/promises';
import net from 'node:net';

// The private-address check the agent's vettedFetch has always used, lifted out
// so the mailbox connector (arbitrary user-supplied IMAP/POP/SMTP hosts) shares
// exactly one implementation with it.

/** An IPv6 literal as eight hextets, a dotted tail folded in; null when it is not one. */
function hextets(v6: string): number[] | null {
  let s = v6;
  const dotted = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    if (!net.isIPv4(dotted[2]!)) return null;
    const [a, b, c, d] = dotted[2]!.split('.').map(Number) as [number, number, number, number];
    s = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const parts = [...head, ...Array<string>(fill).fill('0'), ...tail].map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN));
  return parts.length === 8 && parts.every((n) => Number.isInteger(n)) ? parts : null;
}

/**
 * One spelling per address, so every check below sees the same thing the
 * socket will: brackets and a zone id dropped, IPv6 lowercased and expanded,
 * and an IPv4 carried inside IPv6 — mapped (::ffff:127.0.0.1 and its hex twin
 * ::ffff:7f00:1, which is how the URL parser writes it), the deprecated
 * compatible form (::127.0.0.1) and NAT64 (64:ff9b::/96) — becomes that IPv4.
 */
export function canonicalAddress(ip: string): string {
  const raw = ip.trim().replace(/^\[|\]$/g, '').toLowerCase().split('%')[0]!;
  if (net.isIPv4(raw)) return raw;
  if (!net.isIPv6(raw)) return raw; // not an address at all — every check below fails closed on it
  const p = hextets(raw);
  if (!p) return raw;
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (p[0] === 0 && p[1] === 0 && p[2] === 0 && p[3] === 0 && p[4] === 0) {
    if (p[5] === 0xffff) return v4(p[6]!, p[7]!);
    if (p[5] === 0 && !(p[6] === 0 && p[7]! <= 1)) return v4(p[6]!, p[7]!);
  }
  if (p[0] === 0x64 && p[1] === 0xff9b && p[2] === 0 && p[3] === 0 && p[4] === 0 && p[5] === 0) return v4(p[6]!, p[7]!);
  return p.map((n) => n.toString(16)).join(':');
}

/** RFC1918 + loopback + link-local + CGNAT + unique-local v6 (+ the unspecified
 *  and multicast ranges nothing should be told to connect to). An address this
 *  cannot parse is private: the guard fails closed. */
export function isPrivateAddress(ip: string): boolean {
  const a = canonicalAddress(ip);
  if (net.isIPv4(a)) {
    const [x, y] = a.split('.').map(Number) as [number, number];
    return (
      x === 10 ||
      x === 127 ||
      x === 0 ||
      (x === 172 && y >= 16 && y <= 31) ||
      (x === 192 && y === 168) ||
      (x === 169 && y === 254) ||
      (x === 100 && y >= 64 && y <= 127)
    );
  }
  const p = hextets(a);
  if (!p) return true;
  if (p.every((n) => n === 0)) return true; // ::
  if (p.slice(0, 7).every((n) => n === 0) && p[7] === 1) return true; // ::1
  const first = p[0]!;
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/** This machine's own loopback — 127/8, ::1, or 127/8 IPv4-mapped (::ffff:127.x, as
 *  a socket may spell it) — the one private address a desktop may be allowed.
 *  NAT64 and the deprecated ::a.b.c.d form are translations that ROUTE, so they
 *  stay private (refused) and never qualify here. */
export function isLoopbackAddress(ip: string): boolean {
  const raw = ip.trim().replace(/^\[|\]$/g, '').toLowerCase().split('%')[0]!;
  if (net.isIPv4(raw)) return raw.startsWith('127.');
  if (!net.isIPv6(raw)) return false;
  const p = hextets(raw);
  if (!p) return false;
  if (p.slice(0, 7).every((n) => n === 0) && p[7] === 1) return true;
  return p.slice(0, 5).every((n) => n === 0) && p[5] === 0xffff && p[6]! >> 8 === 127;
}

/**
 * Resolve a hostname and refuse anything landing on a private address. Returns
 * the ONE address that passed: connect to exactly that and pass the hostname as
 * the TLS servername. Resolving twice (once to check, once to connect) is a
 * DNS-rebinding hole — a TTL-0 domain answers public here and 127.0.0.1 there.
 */
/** A target this guard will not let anyone reach — the caller's fault, never the network's. */
export class RefusedError extends Error {}

export async function publicAddress(host: string): Promise<string> {
  const h = host.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(h) ? [{ address: h }] : await dns.lookup(h, { all: true });
  if (!addresses.length) throw new RefusedError(`${host} did not resolve`);
  for (const a of addresses) {
    if (isPrivateAddress(a.address)) throw new RefusedError(`refused: ${host} resolves to the private address ${a.address}`);
  }
  return addresses[0]!.address;
}
