/**
 * WHERE A SERVER-SIDE FETCH MAY GO (Fill From Their Site, 2026-09-27).
 *
 * The server reads a page at an address a person pasted. Left alone, that is a door into the
 * network the server itself sits on: the cloud metadata service at 169.254.169.254, a database on
 * 10.x, the machine's own loopback. So every address is checked here BEFORE a connection is made,
 * on the first host and again on every redirect, and the connection is then pinned to the address
 * that passed (fetch-page.ts), so a second DNS answer can't swap in a private one.
 *
 * IPv4: a deny list of every special-purpose block (RFC 6890 and friends).
 * IPv6: an ALLOW list. Only global unicast (2000::/3) may pass, minus its own special blocks. That
 * refuses ::1, ::, fc00::/7 (unique local, incl. AWS fd00:ec2::254), fe80::/10, ff00::/8, NAT64
 * 64:ff9b::/96 and anything unassigned, without having to name each one. An IPv4-mapped address
 * (::ffff:a.b.c.d) is judged as the IPv4 address it carries.
 */

/** [first address as a 32-bit number, prefix length] */
const V4_BLOCKED: [number, number, string][] = [
  [v4n(0, 0, 0, 0), 8, "this network"],
  [v4n(10, 0, 0, 0), 8, "private"],
  [v4n(100, 64, 0, 0), 10, "carrier-grade NAT"],
  [v4n(127, 0, 0, 0), 8, "loopback"],
  [v4n(169, 254, 0, 0), 16, "link-local (cloud metadata)"],
  [v4n(172, 16, 0, 0), 12, "private"],
  [v4n(192, 0, 0, 0), 24, "IETF protocol assignments"],
  [v4n(192, 0, 2, 0), 24, "documentation"],
  [v4n(192, 88, 99, 0), 24, "6to4 relay"],
  [v4n(192, 168, 0, 0), 16, "private"],
  [v4n(198, 18, 0, 0), 15, "benchmarking"],
  [v4n(198, 51, 100, 0), 24, "documentation"],
  [v4n(203, 0, 113, 0), 24, "documentation"],
  [v4n(224, 0, 0, 0), 4, "multicast"],
  [v4n(240, 0, 0, 0), 4, "reserved"],
];

function v4n(a: number, b: number, c: number, d: number): number {
  return ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;
}

/** "1.2.3.4" → its 32-bit number, or null when it isn't a plain dotted quad. */
export function parseIPv4(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s.trim());
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return v4n(parts[0], parts[1], parts[2], parts[3]);
}

function v4Blocked(n: number): string | null {
  for (const [base, bits, why] of V4_BLOCKED) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if (((n & mask) >>> 0) === base) return why;
  }
  return null;
}

/** An IPv6 address as its 8 sixteen-bit groups, or null when it isn't one. Accepts "::", an
 *  embedded dotted-quad tail ("::ffff:10.0.0.1"), brackets and a zone id ("fe80::1%en0"). */
export function parseIPv6(input: string): number[] | null {
  let s = input.trim().replace(/^\[|\]$/g, "");
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  if (!s.includes(":")) return null;
  // A dotted-quad tail becomes its two hex groups: "::ffff:10.0.0.1" → "::ffff:a00:1".
  const lastColon = s.lastIndexOf(":");
  const maybeV4 = s.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const n = parseIPv4(maybeV4);
    if (n === null) return null;
    s = `${s.slice(0, lastColon + 1)}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  if (!head || !rest) return null;
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    return [...head, ...new Array<number>(fill).fill(0), ...rest];
  }
  return head.length === 8 ? head : null;
}

function v6Blocked(g: number[]): string | null {
  // IPv4-mapped (::ffff:a.b.c.d): the connection goes to that IPv4 address, so judge it as one.
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    const v4 = ((g[6] << 16) >>> 0) + g[7];
    return v4Blocked(v4) ?? null;
  }
  if ((g[0] & 0xe000) !== 0x2000) {
    if (g.every((x) => x === 0)) return "unspecified";
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "loopback";
    if ((g[0] & 0xfe00) === 0xfc00) return "private (unique local)";
    if ((g[0] & 0xffc0) === 0xfe80) return "link-local";
    if ((g[0] & 0xff00) === 0xff00) return "multicast";
    return "not a public address";
  }
  if (g[0] === 0x2001 && g[1] < 0x0200) return "IETF protocol assignments (Teredo and others)";
  if (g[0] === 0x2001 && g[1] === 0x0db8) return "documentation";
  if (g[0] === 0x2002) return "6to4";
  if (g[0] === 0x3fff && g[1] < 0x1000) return "documentation";
  return null;
}

/** Why this IP may not be reached, or null when it is a public address. Anything that doesn't
 *  parse as an IP is refused: the caller only ever hands this an address DNS gave back. */
export function blockedAddress(ip: string): string | null {
  const v4 = parseIPv4(ip);
  if (v4 !== null) return v4Blocked(v4);
  const v6 = parseIPv6(ip);
  if (v6) return v6Blocked(v6);
  return "not an IP address";
}

/** Names that only ever mean "inside": refused before DNS is asked. A public website always has a
 *  dot in its name, so a single label ("intranet", "metadata") is refused too. */
export function blockedHostname(hostname: string): string | null {
  const h = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!h) return "no host";
  if (h.startsWith("[") || parseIPv4(h) !== null) return null; // an IP literal: judged by blockedAddress
  if (h === "localhost" || h.endsWith(".localhost")) return "loopback";
  if (/\.(local|internal|home\.arpa|localdomain|lan|intranet)$/.test(h)) return "a private network name";
  if (!h.includes(".")) return "a private network name";
  return null;
}
