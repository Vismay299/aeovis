import test from "node:test";
import assert from "node:assert/strict";

import {
  SsrfBlockedError,
  assertPublicUrl,
  classifyAddress,
  isPolicyRefusal,
  normalizeTargetUrl,
  parseIpv4Literal,
  parseIpv6Literal,
  safeFetch,
} from "./ssrfGuard.js";

/**
 * R3.7.1 — SSRF guard.
 *
 * Every test here injects `lookup` and `fetchImpl`. Nothing in this file
 * performs a DNS query or a network request; in particular nothing ever
 * touches a real cloud metadata endpoint.
 */

// A lookup that must never be reached (IP literals are decided without DNS).
const noLookup = async () => {
  throw new Error("DNS lookup should not have happened for an IP literal");
};
const lookupPublic = async () => ["93.184.216.34"];

/* ===========================================================================
 * R3.7.9 — THE SSRF CORPUS GUARD, because a loop over an empty list asserts nothing.
 *
 * SIX security corpora in this file define the perimeter against SSRF:
 *   - BLOCKED_LITERALS: loopback, link-local / metadata, private, multicast, IPv6, 6to4, NAT64.
 *   - ALLOWED_LITERALS: legitimate public unicast IPv4 and IPv6 addresses.
 *   - C12_RANGES: the seven non-public IPv6 ranges from finding C12.
 *   - C12_STILL_ALLOWED: carve-outs and boundaries that must stay globally reachable.
 *   - BLOCKED_SCHEMES: dangerous non-http(s) schemes (file, gopher, data, ftp, etc.).
 *   - MALFORMED: boundary-violating inputs that must fail closed with policy error.
 *
 * THE VACUOUS CORPUS DEFECT:
 * Iterating an empty array silently registers 0 tests or passes with 0 assertions.
 * If BLOCKED_LITERALS is emptied, all 68 individual tests disappear and the end-to-end
 * test completes with 0 assertions — leaving the suite 100% green while completely
 * disarming protection against AWS/GCP metadata theft and local service exploitation.
 *
 * FOUR INDEPENDENT CLAIMS (mirroring brightdataZone.test.mjs R1.2.16):
 *   1. FLOOR: rows.length >= committed floor. Catches accidental deletion and shrinkage.
 *   2. SHAPE & REASON:
 *      - tuple corpora: entries must be well-formed tuples carrying an explicit, non-empty
 *        human-readable reason. A row nobody can justify is a row the next editor deletes.
 *      - string list corpora: entries must be strings.
 *   3. UNIQUENESS: no duplicated targets. Catches padding-with-copies to satisfy floor.
 *   4. REQUIRED MEMBERS: specific critical load-bearing targets that must never vanish
 *      (e.g., 169.254.169.254, 127.0.0.1, ::1, metadata endpoints, RFC1918 boundaries).
 *
 * FLOORS DERIVED EXACTLY FROM COMMITTED ARRAY LITERALS:
 *   BLOCKED_LITERALS: 68
 *   ALLOWED_LITERALS: 20
 *   C12_RANGES: 15
 *   C12_STILL_ALLOWED: 16
 *   BLOCKED_SCHEMES: 9
 *   MALFORMED: 6
 * ======================================================================== */
import { assertCorpusIntact } from "./testCorpus.mjs";


// ---------------------------------------------------------------------------
// 1. Notation table — the same loopback/metadata address, spelled every way
// ---------------------------------------------------------------------------

/** [input host, expected reason code, what the notation is] */
const BLOCKED_LITERALS = [
  // --- loopback, in every IPv4 notation an attacker can reach for ----------
  ["127.0.0.1", "loopback", "dotted quad"],
  ["127.0.0.2", "loopback", "dotted quad, not the canonical one"],
  ["127.1", "loopback", "short form"],
  ["2130706433", "loopback", "decimal"],
  ["0x7f000001", "loopback", "hex"],
  ["0x7F000001", "loopback", "hex, upper case"],
  ["0177.0.0.1", "loopback", "octal first octet"],
  ["017700000001", "loopback", "full octal"],
  ["0x7f.0.0.1", "loopback", "mixed hex + decimal"],
  ["0x7f.0.1", "loopback", "mixed hex + short form"],
  ["127.0.0.1.", "loopback", "trailing dot"],

  // --- link-local: the cloud metadata range -------------------------------
  ["169.254.169.254", "link_local", "AWS/GCP/Azure instance metadata"],
  ["169.254.170.2", "link_local", "ECS task metadata"],
  ["2852039166", "link_local", "metadata address in decimal"],
  ["0xa9fea9fe", "link_local", "metadata address in hex"],
  ["0251.0376.0251.0376", "link_local", "metadata address in octal"],
  ["169.254.0.0", "link_local", "range floor"],
  ["169.254.255.255", "link_local", "range ceiling"],

  // --- RFC1918 private ranges, at both edges ------------------------------
  ["10.0.0.0", "private", "10/8 floor"],
  ["10.255.255.255", "private", "10/8 ceiling"],
  ["172.16.0.0", "private", "172.16/12 floor"],
  ["172.31.255.255", "private", "172.16/12 ceiling"],
  ["172.20.10.5", "private", "172.16/12 middle"],
  ["192.168.0.0", "private", "192.168/16 floor"],
  ["192.168.255.255", "private", "192.168/16 ceiling"],
  ["192.168.1.1", "private", "the home-router classic"],

  // --- the rest of the non-public IPv4 space ------------------------------
  ["0.0.0.0", "this_network", "the all-zeroes bind address"],
  ["0.0.0.1", "this_network", "0/8"],
  ["100.64.0.1", "cgnat", "carrier-grade NAT"],
  ["198.18.0.1", "benchmark", "benchmark range"],
  ["192.0.0.1", "reserved", "IETF protocol assignments"],
  ["192.0.2.5", "documentation", "TEST-NET-1"],
  ["198.51.100.5", "documentation", "TEST-NET-2"],
  ["203.0.113.5", "documentation", "TEST-NET-3"],
  ["224.0.0.1", "multicast", "multicast"],
  ["239.255.255.250", "multicast", "SSDP"],
  ["240.0.0.1", "reserved", "reserved 240/4"],
  ["255.255.255.255", "reserved", "broadcast"],

  // --- IPv6 ---------------------------------------------------------------
  ["::1", "loopback", "IPv6 loopback"],
  ["[::1]", "loopback", "IPv6 loopback, bracketed"],
  ["0:0:0:0:0:0:0:1", "loopback", "IPv6 loopback, expanded"],
  ["::", "unspecified", "IPv6 unspecified"],
  ["fe80::1", "link_local", "IPv6 link-local"],
  ["fe80::1%eth0", "link_local", "IPv6 link-local with a zone id"],
  ["febf::1", "link_local", "fe80::/10 ceiling"],
  ["fc00::1", "unique_local", "IPv6 unique local"],
  ["fd12:3456::1", "unique_local", "IPv6 unique local (fd)"],
  ["ff02::1", "multicast", "IPv6 all-nodes multicast"],
  ["100::1", "discard", "IPv6 discard prefix"],
  ["2001:db8::1", "documentation", "IPv6 documentation"],
  ["2001::1", "teredo", "Teredo tunnelling"],

  // --- IPv4 smuggled inside IPv6 -----------------------------------------
  ["::ffff:127.0.0.1", "ipv4_mapped_loopback", "IPv4-mapped loopback"],
  ["[::ffff:127.0.0.1]", "ipv4_mapped_loopback", "IPv4-mapped loopback, bracketed"],
  ["::ffff:7f00:1", "ipv4_mapped_loopback", "IPv4-mapped loopback, hex groups"],
  ["::ffff:169.254.169.254", "ipv4_mapped_link_local", "IPv4-mapped metadata"],
  ["::ffff:a9fe:a9fe", "ipv4_mapped_link_local", "IPv4-mapped metadata, hex groups"],
  ["::ffff:10.0.0.1", "ipv4_mapped_private", "IPv4-mapped RFC1918"],
  ["::127.0.0.1", "ipv4_compat_loopback", "deprecated IPv4-compatible loopback"],
  ["2002:7f00:1::", "6to4_loopback", "6to4 wrapping 127.0.0.1"],
  ["2002:a9fe:a9fe::", "6to4_link_local", "6to4 wrapping the metadata address"],
  ["64:ff9b::a9fe:a9fe", "nat64_link_local", "NAT64 wrapping the metadata address"],

  // --- R3.7.5 / finding C12: the seven ranges the shipped classifier passed --
  ["fec0::1", "site_local", "deprecated IPv6 site-local"],
  ["64:ff9b:1::1", "nat64_local_use", "local-use NAT64 prefix"],
  ["::ffff:8.8.8.8", "ipv4_mapped", "IPv4-mapped wrapping a PUBLIC address"],
  ["2001:2::1", "benchmark", "BMWG IPv6 benchmarking"],
  ["3fff::1", "documentation", "RFC 9637 documentation"],
  ["5f00::1", "segment_routing", "RFC 9602 SRv6 SIDs"],
  ["2001:10::1", "orchid", "deprecated ORCHID"],
];

test("BLOCKED_LITERALS corpus is intact (floor, shape, uniqueness, required members)", () => {
  assertCorpusIntact(BLOCKED_LITERALS, "BLOCKED_LITERALS", {
    floor: 68,
    rowLength: 3,
    isTuple: true,
    required: [
      "127.0.0.1",
      "0x7f000001",
      "169.254.169.254",
      "2852039166",
      "10.0.0.0",
      "192.168.1.1",
      "::1",
      "[::1]",
      "::ffff:127.0.0.1",
      "::ffff:169.254.169.254",
      "64:ff9b::a9fe:a9fe",
      "2002:a9fe:a9fe::",
      "::ffff:8.8.8.8",
      "3fff::1",
      "5f00::1",
    ],
  });
});

for (const [host, expectedReason, notation] of BLOCKED_LITERALS) {
  test(`classifyAddress blocks ${host} (${notation})`, () => {
    const verdict = classifyAddress(host);
    assert.equal(verdict.ip, true, `${host} should parse as an IP literal`);
    assert.equal(verdict.blocked, true, `${host} must be blocked`);
    assert.equal(verdict.reason, expectedReason);
  });
}

test("assertPublicUrl refuses every blocked notation end to end", async () => {
  assertCorpusIntact(BLOCKED_LITERALS, "BLOCKED_LITERALS", {
    floor: 68,
    rowLength: 3,
    isTuple: true,
    required: [
      "127.0.0.1",
      "0x7f000001",
      "169.254.169.254",
      "2852039166",
      "10.0.0.0",
      "192.168.1.1",
      "::1",
      "[::1]",
      "::ffff:127.0.0.1",
      "::ffff:169.254.169.254",
      "64:ff9b::a9fe:a9fe",
      "2002:a9fe:a9fe::",
      "::ffff:8.8.8.8",
      "3fff::1",
      "5f00::1",
    ],
  });
  let tested = 0;
  for (const [host, expectedReason, notation] of BLOCKED_LITERALS) {
    const hostForUrl = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    let url;
    try {
      url = `http://${hostForUrl}/latest/meta-data/`;
      // eslint-disable-next-line no-new
      new URL(url);
    } catch {
      continue; // not expressible as a URL host — the literal table already covers it
    }
    await assert.rejects(
      () => assertPublicUrl(url, { lookup: noLookup }),
      (err) => {
        assert.ok(err instanceof SsrfBlockedError, `${host} (${notation}) must throw SsrfBlockedError`);
        assert.equal(err.code, expectedReason, `${host} (${notation}) reason`);
        return true;
      },
      `${host} (${notation}) reached the network`
    );
    tested++;
  }
  assert.ok(tested >= 60, `assertPublicUrl tested ${tested} hosts, expected at least 60`);
});

// ---------------------------------------------------------------------------
// 2. Public addresses must still pass — a guard that blocks customers is worse
// ---------------------------------------------------------------------------

const ALLOWED_LITERALS = [
  ["8.8.8.8", "public DNS"],
  ["1.1.1.1", "public DNS"],
  ["93.184.216.34", "example.com's old address"],
  ["11.0.0.1", "just past 10/8"],
  ["9.255.255.255", "just before 10/8"],
  ["126.255.255.255", "just before 127/8"],
  ["128.0.0.1", "just past 127/8"],
  ["172.15.255.255", "just before 172.16/12"],
  ["172.32.0.1", "just past 172.16/12"],
  ["169.253.255.255", "just before link-local"],
  ["169.255.0.1", "just past link-local"],
  ["192.167.255.255", "just before 192.168/16"],
  ["192.169.0.1", "just past 192.168/16"],
  ["100.63.255.255", "just before CGNAT"],
  ["100.128.0.1", "just past CGNAT"],
  ["223.255.255.255", "just before multicast"],
  ["2606:4700:4700::1111", "Cloudflare IPv6 resolver"],
  ["2a00:1450:4001:80e::200e", "Google IPv6"],
  ["64:ff9b::8.8.8.8", "NAT64 wrapping a public address"],
  ["2002:0808:0808::", "6to4 wrapping a public address"],
];

test("ALLOWED_LITERALS corpus is intact (floor, shape, uniqueness, required members)", () => {
  assertCorpusIntact(ALLOWED_LITERALS, "ALLOWED_LITERALS", {
    floor: 20,
    rowLength: 2,
    isTuple: true,
    required: [
      "8.8.8.8",
      "1.1.1.1",
      "93.184.216.34",
      "11.0.0.1",
      "128.0.0.1",
      "169.255.0.1",
      "2606:4700:4700::1111",
      "64:ff9b::8.8.8.8",
      "2002:0808:0808::",
    ],
  });
});

for (const [host, why] of ALLOWED_LITERALS) {
  test(`classifyAddress allows public ${host} (${why})`, () => {
    const verdict = classifyAddress(host);
    assert.equal(verdict.ip, true, `${host} should parse as an IP literal`);
    assert.equal(verdict.blocked, false, `${host} must NOT be blocked (${verdict.reason})`);
  });
}

// ---------------------------------------------------------------------------
// 2b. R3.7.5 / finding C12 — the seven IPv6 ranges classifyAddress used to pass
//
// The R3.7.1 verifier enumerated the IPv6 space against the shipped classifier
// and found seven ranges that returned blocked:false. None was a metadata,
// RFC1918 or ULA range, so none was a live SSRF — but none is a public unicast
// address either, and this module claims to answer that question completely.
// The acceptance criterion for R3.7.5 offers a choice: refuse them, or list
// each with the reason it is deliberately allowed. The choice made is REFUSE
// all seven, and these tests pin it so the next reader is not left guessing.
//
// Every range gets a floor, a ceiling, and at least one neighbour that must
// STILL BE ALLOWED, so the fix cannot decay into a blanket IPv6 deny.
// ---------------------------------------------------------------------------

/** [host, expected reason, expected range, what it is] */
const C12_RANGES = [
  ["fec0::", "site_local", "fec0::/10", "deprecated site-local, floor"],
  ["feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "site_local", "fec0::/10", "site-local ceiling"],
  ["64:ff9b:1::", "nat64_local_use", "64:ff9b:1::/48", "local-use NAT64, floor"],
  ["64:ff9b:1:ffff::1", "nat64_local_use", "64:ff9b:1::/48", "local-use NAT64, inside the /48"],
  ["::ffff:0:0", "ipv4_mapped_this_network", null, "IPv4-mapped floor unwraps to 0.0.0.0/8"],
  ["::ffff:8.8.8.8", "ipv4_mapped", "::ffff:0:0/96", "IPv4-mapped wrapping a public address"],
  ["::ffff:255.255.255.254", "ipv4_mapped_reserved", null, "IPv4-mapped, unwraps to 240/4"],
  ["2001:2::", "benchmark", "2001:2::/48", "BMWG benchmarking, floor"],
  ["2001:2:0:ffff::1", "benchmark", "2001:2::/48", "BMWG benchmarking, inside the /48"],
  ["3fff::", "documentation", "3fff::/20", "RFC 9637 documentation, floor"],
  ["3fff:0fff:ffff:ffff:ffff:ffff:ffff:ffff", "documentation", "3fff::/20", "RFC 9637 ceiling"],
  ["5f00::", "segment_routing", "5f00::/16", "SRv6 SIDs, floor"],
  ["5f00:ffff::1", "segment_routing", "5f00::/16", "SRv6 SIDs, ceiling"],
  ["2001:10::", "orchid", "2001:10::/28", "deprecated ORCHID, floor"],
  ["2001:1f:ffff::1", "orchid", "2001:10::/28", "deprecated ORCHID, ceiling"],
];

test("C12 — all seven ranges are refused, with the CIDR that caught them", () => {
  assertCorpusIntact(C12_RANGES, "C12_RANGES", {
    floor: 15,
    rowLength: 4,
    isTuple: true,
    required: [
      "fec0::",
      "64:ff9b:1::",
      "::ffff:0:0",
      "::ffff:8.8.8.8",
      "2001:2::",
      "3fff::",
      "5f00::",
      "2001:10::",
    ],
  });
  const distinctRanges = new Set(
    C12_RANGES.map(([, reason, range]) => range ?? `unwrapped:${reason}`)
  );
  // Seven CIDRs, plus the two IPv4-mapped rows that unwrap to an IPv4 verdict.
  assert.equal(
    [...distinctRanges].filter((r) => !r.startsWith("unwrapped:")).length,
    7,
    "the finding names seven ranges; the table must cover exactly seven"
  );

  for (const [host, reason, range, what] of C12_RANGES) {
    const verdict = classifyAddress(host);
    assert.equal(verdict.ip, true, `${host} (${what}) must parse as an IP literal`);
    assert.equal(verdict.blocked, true, `${host} (${what}) must be blocked`);
    assert.equal(verdict.reason, reason, `${host} (${what}) reason`);
    if (range) assert.equal(verdict.range, range, `${host} (${what}) range`);
  }
});

test("C12 — every refusal is a policy refusal, never 'unusable input'", async () => {
  assertCorpusIntact(C12_RANGES, "C12_RANGES", {
    floor: 15,
    rowLength: 4,
    isTuple: true,
    required: [
      "fec0::",
      "64:ff9b:1::",
      "::ffff:0:0",
      "::ffff:8.8.8.8",
      "2001:2::",
      "3fff::",
      "5f00::",
      "2001:10::",
    ],
  });
  let tested = 0;
  for (const [host, reason, , what] of C12_RANGES) {
    await assert.rejects(
      () => assertPublicUrl(`http://[${host}]/`, { lookup: noLookup }),
      (err) => {
        assert.ok(err instanceof SsrfBlockedError, `${host} (${what})`);
        assert.equal(err.code, reason, `${host} (${what}) code`);
        assert.equal(isPolicyRefusal(err), true, `${host} (${what}) must surface as a block`);
        return true;
      },
      `${host} (${what}) was not refused end to end`
    );
    tested++;
  }
  assert.equal(tested, C12_RANGES.length, "every C12 refusal was checked end to end");
});

test("C12 — a hostname resolving into one of the seven is refused too", async () => {
  await assert.rejects(
    () => assertPublicUrl("https://rebind.example/", { lookup: async () => ["3fff::1"] }),
    (err) => {
      assert.equal(err.code, "documentation");
      assert.match(err.message, /3fff::\/20/);
      return true;
    }
  );
});

/**
 * The other half of the contract: closing these ranges must not close their
 * neighbours. Each row is an address that is adjacent to, or a documented
 * globally-reachable carve-out inside, one of the seven.
 */
const C12_STILL_ALLOWED = [
  ["febf:ffff::1", "still fe80::/10 territory — blocked, but as link_local; see below"],
  ["fe00::1", "fe00::/9 is unallocated, not site-local — must not be swept up by fec0::/10"],
  ["fe7f:ffff::1", "the address immediately below fe80::/10"],
  ["64:ff9b:2::1", "outside the 64:ff9b:1::/48 local-use prefix"],
  ["64:ff9b::8.8.8.8", "the well-known NAT64 prefix wrapping a PUBLIC address"],
  ["8.8.8.8", "the bare IPv4 that ::ffff:8.8.8.8 wraps — the wrapper is the problem"],
  ["2001:1::3", "DNS-SD registration anycast, globally reachable per IANA"],
  ["2001:3::1", "AMT, globally reachable per IANA"],
  ["2001:4:112::1", "AS112-v6, globally reachable per IANA"],
  ["2001:20::1", "ORCHIDv2 — globally reachable, unlike the deprecated 2001:10::/28"],
  ["2001:30::1", "Drone Remote ID, globally reachable per IANA"],
  ["3ffe::1", "one group below 3fff::/20 (the old 6bone space)"],
  ["3fff:1000::1", "past the 20-bit prefix of 3fff::/20"],
  ["5eff:ffff::1", "one group below 5f00::/16"],
  ["5f01::1", "one group past 5f00::/16"],
  ["2606:4700:4700::1111", "an ordinary public resolver, the control case"],
];

test("C12_STILL_ALLOWED corpus is intact (floor, shape, uniqueness, required members)", () => {
  assertCorpusIntact(C12_STILL_ALLOWED, "C12_STILL_ALLOWED", {
    floor: 16,
    rowLength: 2,
    isTuple: true,
    required: [
      "fe00::1",
      "fe7f:ffff::1",
      "64:ff9b:2::1",
      "64:ff9b::8.8.8.8",
      "8.8.8.8",
      "2001:1::3",
      "2001:20::1",
      "3ffe::1",
      "5eff:ffff::1",
    ],
  });
});

for (const [host, why] of C12_STILL_ALLOWED) {
  // febf::1 is genuinely blocked (link-local); it is in the table to document
  // the boundary between fe80::/10 and fec0::/10, not as an allow case.
  if (host.startsWith("febf")) continue;
  test(`C12 — ${host} is still allowed (${why})`, () => {
    const verdict = classifyAddress(host);
    assert.equal(verdict.ip, true, `${host} should parse as an IP literal`);
    assert.equal(verdict.blocked, false, `${host} must NOT be blocked (got ${verdict.reason})`);
  });
}

test("C12 — the fe80::/10 and fec0::/10 boundary is exact, not a single fe00::/8 sweep", () => {
  assertCorpusIntact(C12_STILL_ALLOWED, "C12_STILL_ALLOWED", {
    floor: 16,
    rowLength: 2,
    isTuple: true,
    required: [
      "fe00::1",
      "fe7f:ffff::1",
      "64:ff9b:2::1",
      "64:ff9b::8.8.8.8",
      "8.8.8.8",
      "2001:1::3",
      "2001:20::1",
      "3ffe::1",
      "5eff:ffff::1",
    ],
  });
  assert.equal(classifyAddress("fe7f:ffff::1").blocked, false, "fe7f is below fe80::/10");
  assert.equal(classifyAddress("fe80::1").reason, "link_local");
  assert.equal(classifyAddress("febf:ffff::1").reason, "link_local", "febf is the fe80::/10 ceiling");
  assert.equal(classifyAddress("fec0::1").reason, "site_local", "fec0 starts the deprecated /10");
  assert.equal(classifyAddress("feff:ffff::1").reason, "site_local", "feff is the fec0::/10 ceiling");
  assert.equal(classifyAddress("ff00::1").reason, "multicast", "ff00 hands off to multicast");
});

test("a legitimate customer URL passes the guard untouched", async () => {
  const result = await assertPublicUrl("https://acme-analytics.co.in/pricing?ref=1", {
    lookup: async (hostname) => {
      assert.equal(hostname, "acme-analytics.co.in");
      return ["93.184.216.34", "2606:4700:4700::1111"];
    },
  });
  assert.equal(result.url.toString(), "https://acme-analytics.co.in/pricing?ref=1");
  assert.equal(result.hostname, "acme-analytics.co.in");
  assert.equal(result.literal, false);
  assert.deepEqual(result.addresses, ["93.184.216.34", "2606:4700:4700::1111"]);
});

test("a bare domain with no scheme is upgraded to https, not refused", async () => {
  const result = await assertPublicUrl("acme-analytics.co.in", { lookup: lookupPublic });
  assert.equal(result.url.protocol, "https:");
  assert.equal(result.url.hostname, "acme-analytics.co.in");
});

test("a public IP literal is allowed without any DNS query", async () => {
  const result = await assertPublicUrl("http://93.184.216.34/robots.txt", { lookup: noLookup });
  assert.equal(result.literal, true);
  assert.deepEqual(result.addresses, ["93.184.216.34"]);
});

test("an odd port on a public host is allowed (documented as out of scope)", async () => {
  const result = await assertPublicUrl("https://acme-analytics.co.in:8443/", { lookup: lookupPublic });
  assert.equal(result.url.port, "8443");
});

// ---------------------------------------------------------------------------
// 3. Schemes
// ---------------------------------------------------------------------------

const BLOCKED_SCHEMES = [
  "file:///etc/passwd",
  "file://C:/windows/win.ini",
  "gopher://127.0.0.1:6379/_INFO",
  "data:text/html;base64,PHNjcmlwdD4=",
  "ftp://ftp.example.com/pub",
  "javascript:alert(1)",
  "jar:http://example.com!/",
  "httpx://evil.example.com/",
  "ws://example.com/socket",
];

test("BLOCKED_SCHEMES corpus is intact (floor, shape, uniqueness, required members)", () => {
  assertCorpusIntact(BLOCKED_SCHEMES, "BLOCKED_SCHEMES", {
    floor: 9,
    isTuple: false,
    required: [
      "file:///etc/passwd",
      "gopher://127.0.0.1:6379/_INFO",
      "data:text/html;base64,PHNjcmlwdD4=",
      "javascript:alert(1)",
    ],
  });
});

for (const raw of BLOCKED_SCHEMES) {
  test(`normalizeTargetUrl refuses scheme in ${raw}`, () => {
    assert.throws(
      () => normalizeTargetUrl(raw),
      (err) => {
        assert.ok(err instanceof SsrfBlockedError);
        assert.equal(err.code, "scheme");
        return true;
      }
    );
  });
}

test("http and https are both accepted", () => {
  assert.equal(normalizeTargetUrl("http://example.com/x").protocol, "http:");
  assert.equal(normalizeTargetUrl("HTTPS://Example.com/x").protocol, "https:");
});

// ---------------------------------------------------------------------------
// 4. Credentials, length, malformed input
// ---------------------------------------------------------------------------

test("credentials in the URL are refused even when the host is public", async () => {
  await assert.rejects(
    () => assertPublicUrl("http://user:pass@example.com/", { lookup: lookupPublic }),
    (err) => {
      assert.equal(err.code, "credentials");
      return true;
    }
  );
});

test("a username-only credential is refused too", async () => {
  await assert.rejects(
    () => assertPublicUrl("http://169.254.169.254@example.com/", { lookup: lookupPublic }),
    (err) => {
      assert.equal(err.code, "credentials");
      return true;
    }
  );
});

test("absurdly long input is refused before anything is fetched", async () => {
  const long = `https://example.com/${"a".repeat(4000)}`;
  await assert.rejects(
    () => assertPublicUrl(long, { lookup: lookupPublic }),
    (err) => {
      assert.equal(err.code, "too_long");
      return true;
    }
  );
});

test("an over-long hostname is refused", async () => {
  const host = new Array(10).fill("a".repeat(30)).join(".");
  await assert.rejects(
    () => assertPublicUrl(`https://${host}/`, { lookup: lookupPublic }),
    (err) => {
      assert.equal(err.code, "too_long");
      return true;
    }
  );
});

const MALFORMED = ["https://", "http://", "not a url at all", "http://exa mple.com/"];

test("MALFORMED corpus is intact (floor, shape, uniqueness, required members)", () => {
  assertCorpusIntact(MALFORMED, "MALFORMED", {
    floor: 4,
    isTuple: false,
    required: [
      "https://",
      "http://",
      "not a url at all",
      "http://exa mple.com/",
    ],
  });
});

test("empty and whitespace-only input is refused (not in MALFORMED corpus because the guard rejects empty strings)", async () => {
  for (const raw of ["", "   "]) {
    await assert.rejects(
      () => assertPublicUrl(raw, { lookup: lookupPublic }),
      (err) => {
        assert.ok(err instanceof SsrfBlockedError);
        assert.ok(["empty", "malformed"].includes(err.code), `unexpected code ${err.code}`);
        return true;
      }
    );
  }
});

for (const raw of MALFORMED) {
  test(`malformed input is refused: ${JSON.stringify(raw)}`, async () => {
    await assert.rejects(
      () => assertPublicUrl(raw, { lookup: lookupPublic }),
      (err) => {
        assert.ok(err instanceof SsrfBlockedError);
        assert.ok(["empty", "malformed"].includes(err.code), `unexpected code ${err.code}`);
        return true;
      }
    );
  });
}

test("a non-string target is refused rather than coerced", async () => {
  for (const raw of [null, undefined, 42, {}]) {
    await assert.rejects(() => assertPublicUrl(raw, { lookup: lookupPublic }), SsrfBlockedError);
  }
});

// ---------------------------------------------------------------------------
// 5. DNS rebinding — the case a string check can never catch
// ---------------------------------------------------------------------------

test("a public-looking hostname that resolves to loopback is refused", async () => {
  await assert.rejects(
    () => assertPublicUrl("https://rebind.example.com/", { lookup: async () => ["127.0.0.1"] }),
    (err) => {
      assert.equal(err.code, "loopback");
      assert.equal(err.address, "127.0.0.1");
      return true;
    }
  );
});

test("a hostname that resolves to the metadata address is refused", async () => {
  await assert.rejects(
    () => assertPublicUrl("https://metadata.google.internal.example/", {
      lookup: async () => ["169.254.169.254"],
    }),
    (err) => {
      assert.equal(err.code, "link_local");
      return true;
    }
  );
});

test("EVERY resolved address is checked, not just the first", async () => {
  await assert.rejects(
    () => assertPublicUrl("https://mixed.example.com/", {
      lookup: async () => ["93.184.216.34", "10.1.2.3"],
    }),
    (err) => {
      assert.equal(err.code, "private");
      assert.equal(err.address, "10.1.2.3");
      return true;
    }
  );
});

test("an IPv6 answer in the record set is checked too", async () => {
  await assert.rejects(
    () => assertPublicUrl("https://dual.example.com/", {
      lookup: async () => ["93.184.216.34", "::1"],
    }),
    (err) => {
      assert.equal(err.code, "loopback");
      return true;
    }
  );
});

test("a name that does not resolve is refused, not passed to fetch", async () => {
  await assert.rejects(
    () => assertPublicUrl("https://nxdomain.example/", {
      lookup: async () => {
        const err = new Error("getaddrinfo ENOTFOUND");
        err.code = "ENOTFOUND";
        throw err;
      },
    }),
    (err) => {
      assert.equal(err.code, "dns_failed");
      return true;
    }
  );
});

test("a name that resolves to an empty record set is refused", async () => {
  await assert.rejects(
    () => assertPublicUrl("https://empty.example/", { lookup: async () => [] }),
    (err) => {
      assert.equal(err.code, "dns_empty");
      return true;
    }
  );
});

test("a resolver answer that is not an address at all is refused", async () => {
  await assert.rejects(
    () => assertPublicUrl("https://weird.example/", { lookup: async () => ["not-an-ip"] }),
    (err) => {
      assert.equal(err.code, "dns_unparseable");
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// 6. Redirects — each hop re-checked
// ---------------------------------------------------------------------------

function stubResponse({ status = 200, location = null, body = "ok" } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name.toLowerCase() === "location" ? location : null) },
    async text() {
      return body;
    },
  };
}

test("safeFetch follows a redirect between two public hosts", async () => {
  const seen = [];
  const res = await safeFetch(
    "https://start.example.com/",
    { headers: { "User-Agent": "test" } },
    {
      lookup: lookupPublic,
      fetchImpl: async (url, init) => {
        seen.push(url);
        assert.equal(init.redirect, "manual", "redirects must never be delegated to fetch");
        assert.equal(init.headers["User-Agent"], "test", "caller init must survive each hop");
        return seen.length === 1
          ? stubResponse({ status: 302, location: "https://end.example.com/final" })
          : stubResponse({ status: 200, body: "landed" });
      },
    }
  );
  assert.equal(await res.text(), "landed");
  assert.deepEqual(seen, ["https://start.example.com/", "https://end.example.com/final"]);
});

test("safeFetch REFUSES a public URL that redirects to the metadata address", async () => {
  const seen = [];
  await assert.rejects(
    () =>
      safeFetch(
        "https://innocent.example.com/",
        {},
        {
          lookup: lookupPublic,
          fetchImpl: async (url) => {
            seen.push(url);
            return stubResponse({
              status: 302,
              location: "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
            });
          },
        }
      ),
    (err) => {
      assert.ok(err instanceof SsrfBlockedError);
      assert.equal(err.code, "link_local");
      return true;
    }
  );
  assert.deepEqual(seen, ["https://innocent.example.com/"], "the metadata hop must never be requested");
});

test("safeFetch refuses a redirect to a private address and to loopback", async () => {
  for (const [location, code] of [
    ["http://10.0.0.5/admin", "private"],
    ["http://127.0.0.1:6379/", "loopback"],
    ["http://[::1]/", "loopback"],
    ["http://2130706433/", "loopback"],
    ["file:///etc/passwd", "scheme"],
  ]) {
    await assert.rejects(
      () =>
        safeFetch(
          "https://innocent.example.com/",
          {},
          { lookup: lookupPublic, fetchImpl: async () => stubResponse({ status: 301, location }) }
        ),
      (err) => {
        assert.equal(err.code, code, `redirect to ${location}`);
        return true;
      }
    );
  }
});

test("safeFetch re-checks a redirect whose hostname rebinds to a private address", async () => {
  let call = 0;
  await assert.rejects(
    () =>
      safeFetch(
        "https://hop1.example.com/",
        {},
        {
          lookup: async (hostname) => (hostname === "hop2.example.com" ? ["192.168.0.9"] : ["93.184.216.34"]),
          fetchImpl: async () => {
            call += 1;
            return stubResponse({ status: 302, location: "https://hop2.example.com/" });
          },
        }
      ),
    (err) => {
      assert.equal(err.code, "private");
      return true;
    }
  );
  assert.equal(call, 1, "only the first hop may be fetched");
});

test("a relative Location is resolved against the hop it came from", async () => {
  const seen = [];
  const res = await safeFetch(
    "https://site.example.com/a/b",
    {},
    {
      lookup: lookupPublic,
      fetchImpl: async (url) => {
        seen.push(url);
        return seen.length === 1 ? stubResponse({ status: 302, location: "/c" }) : stubResponse();
      },
    }
  );
  assert.equal(res.status, 200);
  assert.deepEqual(seen, ["https://site.example.com/a/b", "https://site.example.com/c"]);
});

test("a redirect with no Location header is a refusal, not a silent success", async () => {
  await assert.rejects(
    () =>
      safeFetch("https://site.example.com/", {}, {
        lookup: lookupPublic,
        fetchImpl: async () => stubResponse({ status: 302, location: null }),
      }),
    (err) => {
      assert.equal(err.code, "redirect");
      return true;
    }
  );
});

test("an endless redirect chain is capped", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      safeFetch("https://loop.example.com/", {}, {
        lookup: lookupPublic,
        maxRedirects: 3,
        fetchImpl: async () => {
          calls += 1;
          return stubResponse({ status: 302, location: "https://loop.example.com/" });
        },
      }),
    (err) => {
      assert.equal(err.code, "redirect_loop");
      return true;
    }
  );
  assert.equal(calls, 4, "one initial request plus maxRedirects hops");
});

test("a non-redirect response is returned unchanged", async () => {
  const res = await safeFetch("https://site.example.com/", {}, {
    lookup: lookupPublic,
    fetchImpl: async () => stubResponse({ status: 404, body: "nope" }),
  });
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
// 7. The literal parsers themselves
// ---------------------------------------------------------------------------

test("parseIpv4Literal understands each radix", () => {
  assert.equal(parseIpv4Literal("127.0.0.1"), 2130706433);
  assert.equal(parseIpv4Literal("2130706433"), 2130706433);
  assert.equal(parseIpv4Literal("0x7f000001"), 2130706433);
  assert.equal(parseIpv4Literal("0177.0.0.1"), 2130706433);
  assert.equal(parseIpv4Literal("127.1"), 2130706433);
  assert.equal(parseIpv4Literal("0.0.0.0"), 0);
  assert.equal(parseIpv4Literal("255.255.255.255"), 4294967295);
});

test("parseIpv4Literal rejects hostnames and out-of-range octets", () => {
  assert.equal(parseIpv4Literal("example.com"), null);
  assert.equal(parseIpv4Literal("999.1.1.1"), null);
  assert.equal(parseIpv4Literal("1.2.3.4.5"), null);
  assert.equal(parseIpv4Literal("0999.1.1.1"), null); // 9 is not an octal digit
  assert.equal(parseIpv4Literal("0xzz"), null);
  assert.equal(parseIpv4Literal(""), null);
  assert.equal(parseIpv4Literal(null), null);
});

test("parseIpv6Literal expands :: and the dotted tail", () => {
  assert.deepEqual(parseIpv6Literal("::1"), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(parseIpv6Literal("::ffff:127.0.0.1"), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
  assert.deepEqual(parseIpv6Literal("fe80::1"), [0xfe80, 0, 0, 0, 0, 0, 0, 1]);
  assert.equal(parseIpv6Literal("example.com"), null);
  assert.equal(parseIpv6Literal("1::2::3"), null);
  assert.equal(parseIpv6Literal("gggg::1"), null);
});

test("classifyAddress reports a hostname as not-an-IP so the caller must resolve it", () => {
  const verdict = classifyAddress("example.com");
  assert.equal(verdict.ip, false);
  assert.equal(verdict.blocked, false);
});
