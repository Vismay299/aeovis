/**
 * SSRF guard for server-side fetches of user-supplied URLs — R3.7.1, finding S17.
 *
 * WHY THIS EXISTS
 * ---------------
 * A brand's website URL arrives from an ANONYMOUS caller: POST /api/scan is on
 * the public allow-list in src/lib/operatorPerimeter.js. That url is stored on
 * the scan_jobs row and eventually reaches scrapeForSummary() in
 * src/lib/firecrawl.js, whose fallback path does a raw `fetch(url)` from the
 * server and returns the response body to the caller. Before this module, a
 * stranger could post `http://169.254.169.254/latest/meta-data/...` and read
 * cloud instance metadata back out of the scan. That is a read-capable SSRF,
 * not a blind one.
 *
 * WHAT THIS MODULE GUARANTEES
 * ---------------------------
 *   - scheme is http/https and nothing else (file:, gopher:, data:, ftp: refused);
 *   - no credentials in the URL (user:pass@ is a well-known filter bypass);
 *   - bounded length and hostname shape;
 *   - the *resolved* address is a public unicast address, in every notation:
 *     dotted, decimal, octal, hex, mixed, IPv6, IPv4-mapped/6to4/NAT64 IPv6;
 *   - a hostname is RESOLVED and every address it answers with is checked, so a
 *     DNS-rebinding name that points at 127.0.0.1 is refused (a string check
 *     alone cannot catch that);
 *   - redirects are followed MANUALLY and every hop is re-validated, so a public
 *     URL that 302s to 169.254.169.254 is refused at the hop.
 *
 * WHAT IT DOES *NOT* CLOSE — read this before trusting it
 * ------------------------------------------------------
 *   1. TOCTOU / DNS rebinding at connect time. assertPublicUrl() resolves the
 *      name, then safeFetch() hands the *hostname* to fetch(), which resolves
 *      it a second time. An attacker controlling a DNS server with a 0-second
 *      TTL can answer public on the first lookup and private on the second.
 *      This is NARROWED (a name that is statically private is refused, and the
 *      window is milliseconds) but NOT CLOSED. Closing it requires pinning the
 *      vetted address at connect time — an undici Dispatcher with a custom
 *      `connect.lookup` that only ever returns addresses this module approved,
 *      or a raw node:http(s) request with `lookup`/`servername`. undici is not
 *      a declared dependency here and Next.js's global fetch is not swappable
 *      per-call, so that is deliberately left as follow-on work rather than
 *      faked.
 *   2. Ports are not restricted. Any port is allowed on a public address; the
 *      address check is what keeps that from reaching internal services.
 *   3. Response size is not capped here (callers slice their output). A
 *      malicious host can still stream a large body up to the fetch timeout.
 *   4. Nothing here defends the *vendor's* fetch. When Firecrawl scrapes a URL
 *      it does so from Firecrawl's network, not ours; we validate before
 *      handing them a URL mostly so we never disclose internal hostnames to a
 *      third party.
 *
 * Pure + injectable: `lookup` and `fetchImpl` are injectable so the tests make
 * NO network calls and NO DNS calls.
 */

/** Distinct error type so callers can tell "we refused this" from "the site was down". */
export class SsrfBlockedError extends Error {
  constructor(message, { code, target, address } = {}) {
    super(message);
    this.name = "SsrfBlockedError";
    /** Machine-readable reason, e.g. "scheme", "loopback", "link_local", "redirect". */
    this.code = code || "blocked";
    this.target = target || null;
    this.address = address || null;
  }
}

/**
 * Refusal codes that mean "this input is not a usable website" rather than
 * "we caught something pointed at our own network": a typo, an empty string,
 * a name that does not resolve. No fetch happens for these either, so they are
 * not a security bypass — the distinction exists so callers can keep answering
 * "we could not read that site" (422) instead of turning a customer's typo
 * into a 500. Everything NOT in this set is a policy refusal and must be
 * surfaced loudly.
 */
export const UNUSABLE_TARGET_CODES = new Set([
  "empty",
  "malformed",
  "too_long",
  "dns_failed",
  "dns_empty",
  "dns_unparseable",
]);

/** True when this refusal is a security/policy block, not merely unusable input. */
export function isPolicyRefusal(error) {
  return error instanceof SsrfBlockedError && !UNUSABLE_TARGET_CODES.has(error.code);
}

export const MAX_URL_LENGTH = 2048;
export const MAX_HOSTNAME_LENGTH = 253;
export const MAX_REDIRECTS = 5;

// ---------------------------------------------------------------------------
// IPv4 literal parsing — inet_aton semantics (what curl/browsers/libc accept)
// ---------------------------------------------------------------------------

/**
 * Parses every IPv4 notation an attacker can reach for — dotted quad, decimal
 * (`2130706433`), octal (`0177.0.0.1`), hex (`0x7f000001`), short forms
 * (`127.1`) and mixed radix (`0x7f.0.0.1`) — into a 32-bit unsigned integer.
 *
 * Returns null when the input is not an IPv4 literal in ANY notation (i.e. it
 * is a hostname, which the caller must resolve instead).
 */
export function parseIpv4Literal(host) {
  if (typeof host !== "string") return null;
  let value = host.trim();
  if (!value) return null;
  // A single trailing dot is legal in a hostname and does not change the address.
  if (value.endsWith(".")) value = value.slice(0, -1);
  if (!value) return null;

  const parts = value.split(".");
  if (parts.length > 4) return null;

  const numbers = [];
  for (const part of parts) {
    const n = parseRadixPart(part);
    if (n === null) return null;
    numbers.push(n);
  }

  // Leading parts are single octets; the final part absorbs whatever is left.
  const last = numbers.pop();
  for (const n of numbers) {
    if (n > 255) return null;
  }
  const remainingOctets = 4 - numbers.length;
  const maxLast = remainingOctets >= 4 ? 4294967295 : Math.pow(256, remainingOctets) - 1;
  if (last > maxLast) return null;

  let result = 0;
  for (const n of numbers) result = result * 256 + n;
  return result * Math.pow(256, remainingOctets) + last;
}

/**
 * One IPv4 component in decimal, octal (leading 0) or hex (leading 0x).
 *
 * Leading zeros are stripped BEFORE the width check, because zero-padding is
 * itself a filter-bypass trick (`0000000000000177` is octal 127) and a naive
 * length cap would classify it as a hostname instead of an address.
 */
function parseRadixPart(part) {
  if (part === "" || part.length > 64) return null;
  const lower = part.toLowerCase();

  const strip = (digits) => digits.replace(/^0+(?=.)/, "");

  if (lower.startsWith("0x")) {
    const digits = strip(lower.slice(2));
    if (!digits || !/^[0-9a-f]+$/.test(digits) || digits.length > 8) return null;
    return parseInt(digits, 16);
  }
  if (lower.length > 1 && lower.startsWith("0")) {
    const digits = strip(lower.slice(1));
    if (!/^[0-7]+$/.test(digits) || digits.length > 11) return null;
    const value = parseInt(digits, 8);
    return value > 4294967295 ? null : value;
  }
  if (!/^[0-9]+$/.test(lower)) return null;
  const digits = strip(lower);
  if (digits.length > 10) return null;
  const value = parseInt(digits, 10);
  return value > 4294967295 ? null : value;
}

/** Renders a 32-bit integer back to dotted quad, for log/error messages. */
export function ipv4ToDotted(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

// ---------------------------------------------------------------------------
// IPv6 literal parsing
// ---------------------------------------------------------------------------

/**
 * Parses an IPv6 literal (with or without surrounding brackets, with or without
 * a zone id, including the `::ffff:127.0.0.1` dotted tail form) into 8 groups
 * of 16 bits. Returns null if it is not an IPv6 literal.
 */
export function parseIpv6Literal(host) {
  if (typeof host !== "string") return null;
  let value = host.trim();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  if (!value.includes(":")) return null;
  // A zone/scope id (fe80::1%eth0) never changes which range the address is in.
  const percent = value.indexOf("%");
  if (percent !== -1) value = value.slice(0, percent);
  if (!value) return null;

  // A trailing dotted-quad ("::ffff:127.0.0.1") becomes the last two groups.
  let tailGroups = null;
  const lastColon = value.lastIndexOf(":");
  const tail = value.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseStrictDottedQuad(tail);
    if (v4 === null) return null;
    tailGroups = [(v4 >>> 16) & 0xffff, v4 & 0xffff];
    value = value.slice(0, lastColon + 1) + "0:0";
  }

  const doubleColon = value.indexOf("::");
  if (doubleColon !== value.lastIndexOf("::")) return null; // at most one "::"

  let head = [];
  let back = [];
  if (doubleColon === -1) {
    head = value.split(":");
    if (head.length !== 8) return null;
  } else {
    const before = value.slice(0, doubleColon);
    const after = value.slice(doubleColon + 2);
    head = before === "" ? [] : before.split(":");
    back = after === "" ? [] : after.split(":");
    if (head.length + back.length > 7) return null;
  }

  const toGroup = (g) => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    return parseInt(g, 16);
  };

  const headNums = [];
  for (const g of head) {
    const n = toGroup(g);
    if (n === null) return null;
    headNums.push(n);
  }
  const backNums = [];
  for (const g of back) {
    const n = toGroup(g);
    if (n === null) return null;
    backNums.push(n);
  }

  const fill = 8 - headNums.length - backNums.length;
  const groups =
    doubleColon === -1 ? headNums : [...headNums, ...new Array(fill).fill(0), ...backNums];
  if (groups.length !== 8) return null;

  if (tailGroups) {
    groups[6] = tailGroups[0];
    groups[7] = tailGroups[1];
  }
  return groups;
}

/** Strict dotted quad only (no octal/hex) — used for the IPv6 dotted tail. */
function parseStrictDottedQuad(text) {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^[0-9]{1,3}$/.test(p)) return null;
    const v = parseInt(p, 10);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

// ---------------------------------------------------------------------------
// Range classification
// ---------------------------------------------------------------------------

/**
 * Non-public IPv4 blocks. `bits` is the prefix length.
 * 169.254.0.0/16 is the one that matters most in a cloud deployment: it is
 * where AWS/GCP/Azure/DigitalOcean all serve instance metadata.
 */
const IPV4_BLOCKED = [
  { cidr: "0.0.0.0/8", reason: "this_network" },
  { cidr: "10.0.0.0/8", reason: "private" },
  { cidr: "100.64.0.0/10", reason: "cgnat" },
  { cidr: "127.0.0.0/8", reason: "loopback" },
  { cidr: "169.254.0.0/16", reason: "link_local" }, // cloud instance metadata
  { cidr: "172.16.0.0/12", reason: "private" },
  { cidr: "192.0.0.0/24", reason: "reserved" },
  { cidr: "192.0.2.0/24", reason: "documentation" },
  { cidr: "192.88.99.0/24", reason: "reserved" },
  { cidr: "192.168.0.0/16", reason: "private" },
  { cidr: "198.18.0.0/15", reason: "benchmark" },
  { cidr: "198.51.100.0/24", reason: "documentation" },
  { cidr: "203.0.113.0/24", reason: "documentation" },
  { cidr: "224.0.0.0/4", reason: "multicast" },
  { cidr: "240.0.0.0/4", reason: "reserved" }, // includes 255.255.255.255
].map(({ cidr, reason }) => {
  const [base, bitsText] = cidr.split("/");
  return { cidr, reason, base: parseIpv4Literal(base), bits: Number(bitsText) };
});

/** Classifies a 32-bit IPv4 value. */
export function classifyIpv4(value) {
  for (const block of IPV4_BLOCKED) {
    const mask = block.bits === 0 ? 0 : (0xffffffff << (32 - block.bits)) >>> 0;
    if (((value >>> 0) & mask) === ((block.base >>> 0) & mask)) {
      return { blocked: true, reason: block.reason, range: block.cidr };
    }
  }
  return { blocked: false, reason: null, range: null };
}

/**
 * Non-public IPv6 prefixes — R3.7.5, finding C12.
 *
 * Drawn from the IANA IPv6 Special-Purpose Address Registry (every entry whose
 * "Globally Reachable" column is False), plus the two deprecated allocations
 * that are not in that registry but are equally not internet addresses:
 * fec0::/10 (site-local, deprecated by RFC 3879) and 2001:10::/28 (ORCHID,
 * deprecated by RFC 4843/7343). None of these is a cloud-metadata or RFC1918
 * equivalent, so a host resolving into one is more likely broken than hostile —
 * but it is not a public unicast address either, and this module claims to
 * decide that question completely. Refusing is the honest answer.
 *
 * WHAT IS DELIBERATELY *NOT* HERE, and why
 * ----------------------------------------
 *   - 2002::/16 (6to4) and 64:ff9b::/96 (the NAT64 well-known prefix) are
 *     globally reachable per IANA and carry a real IPv4 destination inside
 *     them. They are handled above by unwrapping that IPv4 and classifying it,
 *     so 2002:a9fe:a9fe:: is refused while 2002:0808:0808:: is allowed. A flat
 *     block here would be both wrong and weaker.
 *   - The globally-reachable carve-outs inside 2001::/23 stay allowed on
 *     purpose: 2001:1::1/128 and 2001:1::2/128 (PCP/TURN anycast),
 *     2001:1::3/128 (DNS-SD registration anycast), 2001:3::/32 (AMT),
 *     2001:4:112::/48 (AS112-v6), 2001:20::/28 (ORCHIDv2) and 2001:30::/28
 *     (Drone Remote ID). We block the four sub-blocks of 2001::/23 that IANA
 *     marks unreachable rather than the whole /23.
 *   - 2001:678::/29 and the rest of ordinary global unicast is, correctly,
 *     nobody's business here.
 *
 * Order does not matter: no two prefixes below overlap.
 */
const IPV6_BLOCKED = [
  { cidr: "::/128", reason: "unspecified" },
  { cidr: "::1/128", reason: "loopback" },
  { cidr: "64:ff9b:1::/48", reason: "nat64_local_use" }, // RFC 8215 local-use translation
  { cidr: "100::/64", reason: "discard" },
  { cidr: "2001::/32", reason: "teredo" },
  { cidr: "2001:2::/48", reason: "benchmark" }, // RFC 5180 BMWG
  { cidr: "2001:10::/28", reason: "orchid" }, // deprecated ORCHID
  { cidr: "2001:db8::/32", reason: "documentation" },
  { cidr: "3fff::/20", reason: "documentation" }, // RFC 9637
  { cidr: "5f00::/16", reason: "segment_routing" }, // RFC 9602 SRv6 SIDs
  { cidr: "fc00::/7", reason: "unique_local" },
  { cidr: "fe80::/10", reason: "link_local" },
  { cidr: "fec0::/10", reason: "site_local" }, // deprecated by RFC 3879
  { cidr: "ff00::/8", reason: "multicast" },
].map(({ cidr, reason }) => {
  const [base, bitsText] = cidr.split("/");
  const groups = parseIpv6Literal(base);
  if (!groups) throw new Error(`IPV6_BLOCKED: "${cidr}" is not a parseable IPv6 prefix`);
  return { cidr, reason, base: groups, bits: Number(bitsText) };
});

/** True when `groups` falls inside the prefix `block.base`/`block.bits`. */
function ipv6InPrefix(groups, block) {
  let remaining = block.bits;
  for (let i = 0; i < 8 && remaining > 0; i += 1) {
    const width = Math.min(16, remaining);
    const mask = width === 0 ? 0 : (0xffff << (16 - width)) & 0xffff;
    if ((groups[i] & mask) !== (block.base[i] & mask)) return false;
    remaining -= width;
  }
  return true;
}

/** Classifies 8 IPv6 groups, unwrapping the embedded-IPv4 forms first. */
export function classifyIpv6(groups) {
  const isZeroPrefix = groups.slice(0, 5).every((g) => g === 0);

  // ::ffff:a.b.c.d — IPv4-mapped. The kernel connects to the IPv4 address, so
  // it must be judged by the IPv4 rules, not waved through as "some IPv6".
  if (isZeroPrefix && groups[5] === 0xffff) {
    const v4 = (groups[6] * 65536 + groups[7]) >>> 0;
    const inner = classifyIpv4(v4);
    if (inner.blocked) return { ...inner, reason: `ipv4_mapped_${inner.reason}` };
    // The wrapped IPv4 is public, but ::ffff:0:0/96 is still not a destination:
    // IANA marks it not-globally-reachable, and nothing this module calls can
    // legitimately produce one (defaultLookup never passes AI_V4MAPPED, so the
    // resolver returns 8.8.8.8, not ::ffff:8.8.8.8). An answer in this range is
    // a misconfigured resolver or a probe, and either way the caller asked for
    // a website, not for us to guess which address family it meant.
    return { blocked: true, reason: "ipv4_mapped", range: "::ffff:0:0/96" };
  }
  // ::a.b.c.d — deprecated IPv4-compatible form, same reasoning.
  if (isZeroPrefix && groups[5] === 0 && !(groups[6] === 0 && groups[7] <= 1)) {
    const v4 = (groups[6] * 65536 + groups[7]) >>> 0;
    const inner = classifyIpv4(v4);
    if (inner.blocked) return { ...inner, reason: `ipv4_compat_${inner.reason}` };
    return { blocked: true, reason: "ipv4_compat", range: "::/96" };
  }
  // 64:ff9b::/96 — NAT64. Embedded IPv4 in the last two groups.
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0) {
    const v4 = (groups[6] * 65536 + groups[7]) >>> 0;
    const inner = classifyIpv4(v4);
    if (inner.blocked) return { ...inner, reason: `nat64_${inner.reason}` };
    return { blocked: false, reason: null, range: null };
  }
  // 2002::/16 — 6to4. Embedded IPv4 sits in groups 1 and 2.
  if (groups[0] === 0x2002) {
    const v4 = (groups[1] * 65536 + groups[2]) >>> 0;
    const inner = classifyIpv4(v4);
    if (inner.blocked) return { ...inner, reason: `6to4_${inner.reason}` };
    return { blocked: false, reason: null, range: null };
  }

  // Everything else is a plain prefix match against the table above. `::` and
  // `::1` reach here rather than the ::/96 branch because that branch excludes
  // them explicitly.
  for (const block of IPV6_BLOCKED) {
    if (ipv6InPrefix(groups, block)) {
      return { blocked: true, reason: block.reason, range: block.cidr };
    }
  }
  return { blocked: false, reason: null, range: null };
}

/**
 * Classifies any IP literal, in any notation, IPv4 or IPv6.
 * @returns {{ ip: boolean, blocked: boolean, reason: string|null, range: string|null }}
 *   `ip: false` means the input is not an address literal at all — a hostname,
 *   which the caller MUST resolve before deciding.
 */
export function classifyAddress(host) {
  const groups = parseIpv6Literal(host);
  if (groups) return { ip: true, ...classifyIpv6(groups) };

  const v4 = parseIpv4Literal(host);
  if (v4 !== null) return { ip: true, ...classifyIpv4(v4) };

  return { ip: false, blocked: false, reason: null, range: null };
}

// ---------------------------------------------------------------------------
// URL normalization + validation
// ---------------------------------------------------------------------------

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Normalizes user input into a URL object, refusing anything that is not a
 * plain http/https request for a plausibly-public host.
 *
 * A bare `example.com` (no scheme) is upgraded to https — that is how brand
 * URLs actually arrive from the scan form. Anything that DOES carry a scheme
 * must carry http or https; `file:`, `gopher:`, `data:`, `ftp:` and the
 * "starts with the letters http" near-misses (`httpx://`) are refused rather
 * than silently mangled.
 *
 * @throws {SsrfBlockedError}
 */
export function normalizeTargetUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new SsrfBlockedError("URL is empty.", { code: "empty", target: String(raw ?? "") });
  }
  const trimmed = raw.trim();
  if (trimmed.length > MAX_URL_LENGTH) {
    throw new SsrfBlockedError(`URL exceeds ${MAX_URL_LENGTH} characters.`, {
      code: "too_long",
      target: trimmed.slice(0, 80),
    });
  }
  // Control characters and whitespace inside a URL are request-smuggling bait.
  if (/[\s\u0000-\u0020\u007f]/.test(trimmed)) {
    throw new SsrfBlockedError("URL contains whitespace or control characters.", {
      code: "malformed",
      target: trimmed.slice(0, 80),
    });
  }

  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed);
  const candidate = hasScheme ? trimmed : `https://${trimmed}`;

  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new SsrfBlockedError("URL could not be parsed.", {
      code: "malformed",
      target: trimmed.slice(0, 80),
    });
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new SsrfBlockedError(`Scheme "${url.protocol}" is not allowed; only http and https are.`, {
      code: "scheme",
      target: trimmed.slice(0, 80),
    });
  }
  if (url.username || url.password) {
    throw new SsrfBlockedError("URLs with embedded credentials are not allowed.", {
      code: "credentials",
      target: `${url.protocol}//${url.hostname}${url.pathname}`,
    });
  }
  if (!url.hostname) {
    throw new SsrfBlockedError("URL has no host.", { code: "malformed", target: trimmed.slice(0, 80) });
  }
  if (url.hostname.length > MAX_HOSTNAME_LENGTH) {
    throw new SsrfBlockedError(`Hostname exceeds ${MAX_HOSTNAME_LENGTH} characters.`, {
      code: "too_long",
      target: url.hostname.slice(0, 80),
    });
  }
  return url;
}

/** Strips the brackets WHATWG keeps on an IPv6 hostname. */
export function bareHostname(url) {
  const h = url.hostname;
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}

let cachedLookup = null;
/** Lazily loads node:dns so this module stays importable where dns is absent. */
async function defaultLookup(hostname) {
  if (!cachedLookup) {
    const dns = await import("node:dns/promises");
    cachedLookup = dns.lookup;
  }
  const records = await cachedLookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

/**
 * The full check: normalize, then establish that the target resolves ONLY to
 * public unicast addresses.
 *
 * Every returned address is checked, not just the first — a DNS-rebinding host
 * that answers with one public and one private address is refused. A hostname
 * that fails to resolve is refused too: an unresolvable name is not a safe
 * name, it is an unknown one, and letting it through would hand the decision
 * back to fetch()'s own resolver.
 *
 * @param {string} raw user-supplied URL
 * @param {{ lookup?: (hostname: string) => Promise<string[]> }} [deps]
 * @returns {Promise<{ url: URL, hostname: string, addresses: string[], literal: boolean }>}
 * @throws {SsrfBlockedError}
 */
export async function assertPublicUrl(raw, deps = {}) {
  const url = normalizeTargetUrl(raw);
  const host = bareHostname(url);

  const literal = classifyAddress(host);
  if (literal.ip) {
    if (literal.blocked) {
      throw new SsrfBlockedError(
        `Refused ${host}: ${literal.reason} address (${literal.range}).`,
        { code: literal.reason, target: url.toString(), address: host }
      );
    }
    return { url, hostname: host, addresses: [host], literal: true };
  }

  const lookup = deps.lookup || defaultLookup;
  let addresses;
  try {
    addresses = await lookup(host);
  } catch (err) {
    throw new SsrfBlockedError(`Refused ${host}: DNS lookup failed (${err?.code || err?.message || "error"}).`, {
      code: "dns_failed",
      target: url.toString(),
    });
  }

  const list = (Array.isArray(addresses) ? addresses : [addresses]).filter(Boolean);
  if (!list.length) {
    throw new SsrfBlockedError(`Refused ${host}: name resolved to no addresses.`, {
      code: "dns_empty",
      target: url.toString(),
    });
  }

  for (const address of list) {
    const verdict = classifyAddress(address);
    if (!verdict.ip) {
      throw new SsrfBlockedError(`Refused ${host}: resolver returned an unparseable address.`, {
        code: "dns_unparseable",
        target: url.toString(),
        address: String(address),
      });
    }
    if (verdict.blocked) {
      throw new SsrfBlockedError(
        `Refused ${host}: resolves to ${address}, a ${verdict.reason} address (${verdict.range}).`,
        { code: verdict.reason, target: url.toString(), address: String(address) }
      );
    }
  }

  return { url, hostname: host, addresses: list, literal: false };
}

/**
 * fetch() for user-supplied URLs.
 *
 * Redirects are followed BY HAND (`redirect: "manual"`) so each Location is put
 * through assertPublicUrl() before it is requested. Letting fetch follow
 * redirects itself would leave the classic bypass wide open: a public URL that
 * 302s to 169.254.169.254.
 *
 * Every refusal throws SsrfBlockedError — it never degrades to an empty
 * response, because "we refused this on purpose" and "the site was down" must
 * not look the same to the caller.
 *
 * @param {string} raw
 * @param {RequestInit} [init]
 * @param {{ lookup?: Function, fetchImpl?: Function, maxRedirects?: number }} [deps]
 */
export async function safeFetch(raw, init = {}, deps = {}) {
  const doFetch = deps.fetchImpl || globalThis.fetch;
  const maxRedirects = deps.maxRedirects ?? MAX_REDIRECTS;

  let current = raw;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const { url } = await assertPublicUrl(current, deps);

    const response = await doFetch(url.toString(), { ...init, redirect: "manual" });
    const status = response?.status ?? 0;

    if (status >= 300 && status < 400) {
      const location = response.headers?.get?.("location");
      if (!location) {
        throw new SsrfBlockedError(`Refused ${url.hostname}: ${status} redirect with no Location header.`, {
          code: "redirect",
          target: url.toString(),
        });
      }
      if (hop === maxRedirects) {
        throw new SsrfBlockedError(`Refused ${url.hostname}: more than ${maxRedirects} redirects.`, {
          code: "redirect_loop",
          target: url.toString(),
        });
      }
      // Resolve relative Locations against the hop we just made, then re-check.
      current = new URL(location, url).toString();
      continue;
    }

    return response;
  }

  // Unreachable: the loop either returns or throws.
  throw new SsrfBlockedError("Redirect handling fell through.", { code: "redirect_loop", target: String(raw) });
}
