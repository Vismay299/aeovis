#!/usr/bin/env node
// F23 phase 5 public-page header check (P5.T1.S2). Free and safe on previews:
// only anonymous GETs, no writes, no report text is printed.
//
// Usage:
//   node scripts/qa/check-f23-public.mjs <origin> <token>
//
// With args it asserts the hosted header contract for one shared report:
//   - GET /s/<token>            200, no-store, wrapper CSP, noindex, no-referrer,
//                               nosniff, DENY framing, iframe points at raw
//   - GET /s/<token>/raw        200 with `public, max-age=0, s-maxage=60` and the
//                               document CSP, both without Sec-Fetch-Dest and with
//                               `Sec-Fetch-Dest: iframe`
//   - GET /s/<token>/raw with `Sec-Fetch-Dest: document`  302 to /s/<token>
//   - GET /s/<token>/raw?x=1    302 to the bare path (cache-busting defence)
//   - GET /s/<token>/og.png     200 image/png 1200x630, no-store, noindex
//   - /robots.txt does not disallow /s/, /sitemap.xml has no /s/ URL

import assert from "node:assert/strict";

if (process.argv.length !== 4) {
  console.error("usage: check-f23-public.mjs <origin> <token>");
  process.exit(2);
}

const [, , originArg, token] = process.argv;
const origin = originArg.replace(/\/+$/, "");
const share = `/s/${token}`;
const raw = `/s/${token}/raw`;

const get = (path, options = {}) =>
  fetch(new URL(path, origin), {
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    ...options,
  });

function header(response, name, path) {
  const value = response.headers.get(name);
  assert.ok(value !== null, `${path}: missing ${name}`);
  return value;
}

/** Parse PNG width/height from the IHDR chunk; no image dependency needed. */
function pngDimensions(bytes) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < signature.length; i += 1) assert.equal(bytes[i], signature[i], "og.png must be a PNG");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(8), 13, "og.png IHDR length");
  assert.equal(String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]), "IHDR", "og.png IHDR");
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

try {
  // 1. The wrapper page.
  {
    const response = await get(share);
    assert.equal(response.status, 200, share);
    assert.equal(header(response, "content-type", share), "text/html; charset=utf-8");
    assert.equal(header(response, "cache-control", share), "no-store");
    const csp = header(response, "content-security-policy", share);
    assert.ok(csp.includes("frame-ancestors 'none'"), `${share}: wrapper CSP must not be frameable`);
    assert.ok(csp.includes("script-src 'sha256-"), `${share}: wrapper CSP must pin the share script`);
    assert.equal(header(response, "x-robots-tag", share), "noindex, nofollow");
    assert.equal(header(response, "referrer-policy", share), "no-referrer");
    assert.equal(header(response, "x-content-type-options", share), "nosniff");
    assert.equal(header(response, "x-frame-options", share), "DENY");
    const html = await response.text();
    assert.ok(html.includes(`<iframe src="${raw}"`), `${share}: wrapper must frame the raw document`);
    assert.ok(html.includes('<meta name="robots" content="noindex, nofollow">'), `${share}: meta robots`);
  }

  // 2. The raw document: no destination header (curl, link-preview fetcher), then framed.
  const rawCspChecks = (csp) => {
    assert.ok(csp.startsWith("sandbox "), `${raw}: document CSP must start with the sandbox directive`);
    assert.ok(csp.includes("allow-popups"), `${raw}: document CSP must keep target=_blank working`);
    assert.ok(!csp.includes("allow-scripts"), `${raw}: document CSP must not run scripts`);
    assert.ok(!csp.includes("allow-same-origin"), `${raw}: document CSP must stay opaque`);
    assert.ok(csp.includes("frame-ancestors 'self'"), `${raw}: document CSP must pin framing`);
  };
  for (const dest of [null, "iframe"]) {
    const label = dest === null ? `${raw} (no Sec-Fetch-Dest)` : `${raw} (Sec-Fetch-Dest: iframe)`;
    const response = await get(raw, dest === null ? {} : { headers: { "Sec-Fetch-Dest": dest } });
    assert.equal(response.status, 200, label);
    assert.equal(header(response, "content-type", label), "text/html; charset=utf-8");
    assert.equal(header(response, "cache-control", label), "public, max-age=0, s-maxage=60");
    rawCspChecks(header(response, "content-security-policy", label));
    assert.equal(header(response, "x-robots-tag", label), "noindex, nofollow");
    assert.equal(header(response, "referrer-policy", label), "no-referrer");
    assert.equal(header(response, "x-content-type-options", label), "nosniff");
    assert.equal(header(response, "cross-origin-opener-policy", label), "same-origin");
    await response.text();
  }

  // 3. A top-level navigation to the document bounces to the wrapper.
  {
    const response = await get(raw, { headers: { "Sec-Fetch-Dest": "document" } });
    assert.equal(response.status, 302, `${raw} (Sec-Fetch-Dest: document)`);
    assert.equal(response.headers.get("location"), share);
  }

  // 4. A query string bounces to the bare path before anything is read.
  {
    const response = await get(`${raw}?x=1`);
    assert.equal(response.status, 302, `${raw}?x=1`);
    assert.equal(response.headers.get("location"), raw);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }

  // 5. The preview image.
  {
    const path = `${share}/og.png`;
    const response = await get(path);
    assert.equal(response.status, 200, path);
    assert.equal(header(response, "content-type", path), "image/png");
    assert.equal(header(response, "cache-control", path), "no-store");
    assert.equal(header(response, "x-robots-tag", path), "noindex, nofollow");
    assert.equal(header(response, "x-content-type-options", path), "nosniff");
    const bytes = new Uint8Array(await response.arrayBuffer());
    const { width, height } = pngDimensions(bytes);
    assert.equal(width, 1200, `${path}: width`);
    assert.equal(height, 630, `${path}: height`);
  }

  // 6. Indexing: /s/ is noindexed through headers and meta, never disallowed,
  // so crawlers and preview bots can read the noindex and the OG tags (T7).
  {
    const robots = await (await get("/robots.txt")).text();
    for (const line of robots.split("\n")) {
      const match = /^\s*Disallow\s*:\s*(\S+)/i.exec(line);
      if (match) {
        const disallowed = match[1].trim();
        assert.ok(
          disallowed !== "/s" && !disallowed.startsWith("/s/") && !disallowed.startsWith("/s$"),
          `robots.txt must not disallow /s/: ${line.trim()}`,
        );
      }
    }
    const sitemap = await (await get("/sitemap.xml")).text();
    assert.ok(!sitemap.includes("/s/"), "sitemap.xml must have no /s/ URL");
    const rawCached = await get(raw);
    console.log(`observed x-vercel-cache on raw: ${rawCached.headers.get("x-vercel-cache") ?? "(absent)"}`);
    await rawCached.text();
  }

  console.log("f23 public: all checks passed");
} catch (error) {
  console.error(`f23 public check failed: ${error.message}`);
  process.exitCode = 1;
}
