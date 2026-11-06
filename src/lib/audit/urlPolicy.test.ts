import test from "node:test";
import assert from "node:assert/strict";
import {
  isOwnedHost,
  isCrawlableUrl,
  isBlockedHost,
  isShopifyHost,
  normalizeAndValidateStartUrl,
  resolveStartUrlRedirects,
} from "./urlPolicy.ts";

test("isOwnedHost correctly matches subdomains and exact domain, refuses off-site", () => {
  assert.equal(isOwnedHost("blog.offcult.in", "offcult.in"), true);
  assert.equal(isOwnedHost("offcult.in.evil.com", "offcult.in"), false);
  assert.equal(isOwnedHost("www.offcult.in", "offcult.in"), true);
  assert.equal(isOwnedHost("offcult.in", "offcult.in"), true);
  assert.equal(isOwnedHost("shop.offcult.in:8080", "offcult.in"), true);
  assert.equal(isOwnedHost("anotherdomain.com", "offcult.in"), false);
});

test("isCrawlableUrl blocks private IP literals, loopbacks, and non-http schemes", () => {
  assert.equal(isCrawlableUrl("http://169.254.169.254/"), false);
  assert.equal(isCrawlableUrl("http://127.0.0.1/test"), false);
  assert.equal(isCrawlableUrl("http://10.0.0.1/"), false);
  assert.equal(isCrawlableUrl("http://192.168.1.1/"), false);
  assert.equal(isCrawlableUrl("http://[::1]/"), false);
  assert.equal(isCrawlableUrl("http://localhost:3000/"), false);
  assert.equal(isCrawlableUrl("http://site.local/"), false);
  assert.equal(isCrawlableUrl("ftp://example.com/"), false);
  assert.equal(isCrawlableUrl("https://example.com/"), true);
  assert.equal(isCrawlableUrl("https://blog.example.com/path?a=1"), true);
});

test("isShopifyHost detects Shopify 23.227.38.0/24 subnet", async () => {
  const mockLookup = async (host: string) => {
    if (host === "shop.example.com") return ["23.227.38.32"];
    return ["93.184.216.34"];
  };

  assert.equal(await isShopifyHost("shop.example.com", { lookup: mockLookup }), true);
  assert.equal(await isShopifyHost("regular.example.com", { lookup: mockLookup }), false);
});

test("normalizeAndValidateStartUrl validates public hosts and rejects SSRF targets", async () => {
  const mockLookup = async (host: string) => {
    if (host === "private.example.com") return ["10.0.0.1"];
    if (host === "example.com") return ["93.184.216.34"];
    throw new Error("ENOTFOUND");
  };

  const valid = await normalizeAndValidateStartUrl("example.com/start#hash", { lookup: mockLookup });
  assert.equal(valid, "https://example.com/start");

  await assert.rejects(
    () => normalizeAndValidateStartUrl("127.0.0.1", { lookup: mockLookup }),
    { code: "url_blocked" },
  );

  await assert.rejects(
    () => normalizeAndValidateStartUrl("private.example.com", { lookup: mockLookup }),
    { code: "url_blocked" },
  );
});

test("resolveStartUrlRedirects follows safe redirects and refuses hops to private targets", async () => {
  // Scenario 1: 301 -> 301 -> 200
  const responses: Record<string, { status: number; headers: Record<string, string> }> = {
    "https://example.com/start": {
      status: 301,
      headers: { location: "https://example.com/middle" },
    },
    "https://example.com/middle": {
      status: 301,
      headers: { location: "https://example.com/final" },
    },
    "https://example.com/final": {
      status: 200,
      headers: { "powered-by": "Shopify" },
    },
  };

  const mockSafeFetch = async (url: string) => {
    const res = responses[url] ?? { status: 404, headers: {} };
    return {
      status: res.status,
      headers: new Headers(res.headers),
      body: new Uint8Array(),
    };
  };

  const mockLookup = async () => ["93.184.216.34"];

  const result1 = await resolveStartUrlRedirects("https://example.com/start", {
    safeFetch: mockSafeFetch as any,
    lookup: mockLookup,
  });
  assert.equal(result1.url, "https://example.com/final");
  assert.equal(result1.poweredBy, "Shopify");

  // Scenario 2: 301 -> redirect to 127.0.0.1 (refused)
  const badResponses: Record<string, { status: number; headers: Record<string, string> }> = {
    "https://example.com/hop1": {
      status: 301,
      headers: { location: "http://127.0.0.1/admin" },
    },
  };

  const mockBadFetch = async (url: string) => {
    const res = badResponses[url] ?? { status: 404, headers: {} };
    return {
      status: res.status,
      headers: new Headers(res.headers),
      body: new Uint8Array(),
    };
  };

  const result2 = await resolveStartUrlRedirects("https://example.com/hop1", {
    safeFetch: mockBadFetch as any,
    lookup: mockLookup,
  });
  // Must stop at the last valid URL before the refused hop
  assert.equal(result2.url, "https://example.com/hop1");
});
