import test from "node:test";
import assert from "node:assert/strict";
import {
  PREFERRED_PRODUCTION_ORIGIN,
  PREFERRED_PRODUCTION_HOST,
  PUBLIC_INDEXABLE_ROUTES,
  PRIVATE_ROUTE_PREFIXES,
  normalizePathname,
  getCanonicalUrl,
  getPublicUrlInventory,
  getRouteIndexingPolicy,
  generateRobotsTxt,
  generateSitemapXml,
  resolveHostPolicy,
  validateMarketingClaims,
} from "../publicSite.js";
import robotsHandler from "../../app/robots.js";
import sitemapHandler from "../../app/sitemap.js";

/* ------------------------------------------------------------------ *
 * R20-01 (Level U)
 * ------------------------------------------------------------------ */
test("R20-01 — preferred hostname/page path generates correct canonical URL without preview or local leakage", () => {
  // Preferred production URL generation
  const root = getCanonicalUrl("/");
  assert.equal(root, PREFERRED_PRODUCTION_ORIGIN);

  const privacy = getCanonicalUrl("/privacy");
  assert.equal(privacy, `${PREFERRED_PRODUCTION_ORIGIN}/privacy`);

  const termsWithSlash = getCanonicalUrl("/terms/");
  assert.equal(termsWithSlash, `${PREFERRED_PRODUCTION_ORIGIN}/terms`);

  const pathWithQuery = getCanonicalUrl("/demo?utm_source=test#anchor");
  assert.equal(pathWithQuery, `${PREFERRED_PRODUCTION_ORIGIN}/demo`);

  // Refusal to leak preview or localhost hostnames in canonical
  const fromPreviewHost = getCanonicalUrl("/demo", "https://perceev-preview-123.vercel.app");
  assert.equal(fromPreviewHost, `${PREFERRED_PRODUCTION_ORIGIN}/demo`);

  const fromLocalhost = getCanonicalUrl("/terms", "http://localhost:3000");
  assert.equal(fromLocalhost, `${PREFERRED_PRODUCTION_ORIGIN}/terms`);

  const fromLocalDomain = getCanonicalUrl("/privacy", "http://app.local");
  assert.equal(fromLocalDomain, `${PREFERRED_PRODUCTION_ORIGIN}/privacy`);
});

/* ------------------------------------------------------------------ *
 * R20-02 (Level U)
 * ------------------------------------------------------------------ */
test("R20-02 — public URL inventory generates sitemap with only intended indexable URLs and non-invented dates", () => {
  const inventory = getPublicUrlInventory();
  assert.ok(Array.isArray(inventory));
  assert.equal(inventory.length, 4, "exact public indexable pages inventory");

  const paths = inventory.map((item) => item.path);
  assert.deepEqual(paths.sort(), ["/", "/demo", "/privacy", "/terms"]);

  // Every URL is an absolute canonical production URL
  for (const item of inventory) {
    assert.match(item.url, /^https:\/\/perceev\.com/);
    assert.doesNotMatch(item.url, /(localhost|vercel\.app|\.local)/);
    // Non-invented ISO timestamp
    assert.match(item.lastModified, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const date = new Date(item.lastModified);
    assert.ok(!isNaN(date.getTime()));
    assert.ok(date <= new Date(), "lastModified cannot be in the future");
    assert.ok(item.priority >= 0.1 && item.priority <= 1.0);
    assert.ok(["daily", "weekly", "monthly"].includes(item.changeFrequency));
  }

  // Confirm private routes are NOT in the sitemap
  for (const prefix of PRIVATE_ROUTE_PREFIXES) {
    assert.ok(!paths.some((p) => p.startsWith(prefix)), `private route ${prefix} must not appear in sitemap`);
  }
});

/* ------------------------------------------------------------------ *
 * R20-03 (Level U)
 * ------------------------------------------------------------------ */
test("R20-03 — public, private, and preview route policies match declared indexing intent without treating robots as authentication", () => {
  // Public indexable routes
  const homePolicy = getRouteIndexingPolicy("/", { NODE_ENV: "production" });
  assert.equal(homePolicy.index, true);
  assert.equal(homePolicy.follow, true);
  assert.equal(homePolicy.disallowRobots, false);
  assert.equal(homePolicy.reason, "public_indexable");
  assert.equal(homePolicy.isAuthentication, false, "robots rules are never authentication");

  // Private routes disallow indexing via robots and metadata
  for (const prefix of PRIVATE_ROUTE_PREFIXES) {
    const policy = getRouteIndexingPolicy(`${prefix}/settings`, { NODE_ENV: "production" });
    assert.equal(policy.index, false, `${prefix} must not be indexed`);
    assert.equal(policy.follow, false, `${prefix} must not be followed`);
    assert.equal(policy.disallowRobots, true, `${prefix} must be disallowed in robots.txt`);
    assert.equal(policy.isAuthentication, false, "robots disallow is discovery guidance, not access control");
    assert.equal(policy.reason, "private_route");
  }

  // Preview environment disallows all indexing
  const previewPolicy = getRouteIndexingPolicy("/terms", { VERCEL_ENV: "preview" });
  assert.equal(previewPolicy.index, false, "preview deployment must not be indexed");
  assert.equal(previewPolicy.disallowRobots, true);
  assert.equal(previewPolicy.reason, "preview_deployment");
});

/* ------------------------------------------------------------------ *
 * R20-04 (Level I)
 * ------------------------------------------------------------------ */
test("R20-04 — production build robots and sitemap metadata handlers return valid structure and correct host references", () => {
  // Test Next.js App Router metadata robots handler
  const robotsData = robotsHandler();
  assert.ok(robotsData);
  assert.equal(robotsData.rules.userAgent, "*");
  assert.equal(robotsData.rules.allow, "/");
  assert.ok(Array.isArray(robotsData.rules.disallow));
  for (const prefix of PRIVATE_ROUTE_PREFIXES) {
    assert.ok(
      robotsData.rules.disallow.includes(`${prefix}/`),
      `robots must disallow ${prefix}/`
    );
  }
  assert.equal(robotsData.sitemap, "https://perceev.com/sitemap.xml");

  // Test Next.js App Router metadata sitemap handler
  const sitemapData = sitemapHandler();
  assert.ok(Array.isArray(sitemapData));
  assert.equal(sitemapData.length, 4);
  const urls = sitemapData.map((e) => e.url);
  assert.ok(urls.includes("https://perceev.com"));
  assert.ok(urls.includes("https://perceev.com/terms"));
  assert.ok(urls.includes("https://perceev.com/privacy"));
  assert.ok(urls.includes("https://perceev.com/demo"));
  for (const entry of sitemapData) {
    assert.ok(entry.lastModified instanceof Date);
    assert.ok(!isNaN(entry.lastModified.getTime()));
  }

  // Test formatted text and XML generators
  const txt = generateRobotsTxt();
  assert.match(txt, /User-agent:\s*\*/);
  assert.match(txt, /Allow:\s*\//);
  assert.match(txt, /Disallow:\s*\/portal\//);
  assert.match(txt, /Sitemap:\s*https:\/\/perceev\.com\/sitemap\.xml/);

  const xml = generateSitemapXml();
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.match(xml, /<loc>https:\/\/perceev\.com<\/loc>/);
  assert.match(xml, /<\/urlset>$/);
});

/* ------------------------------------------------------------------ *
 * R20-05 (Level I)
 * ------------------------------------------------------------------ */
test("R20-05 — preferred and alias URL requests enforce host policy without redirect loops or contradictory canonical", () => {
  // Preferred host
  const preferred = resolveHostPolicy("perceev.com");
  assert.equal(preferred.isPreferred, true);
  assert.equal(preferred.isAlias, false);
  assert.equal(preferred.redirectTarget, null, "preferred host needs no redirect");
  assert.equal(preferred.canonicalHost, "perceev.com");

  // Alias host (e.g. www.perceev.com)
  const alias = resolveHostPolicy("www.perceev.com");
  assert.equal(alias.isPreferred, false);
  assert.equal(alias.isAlias, true);
  assert.equal(alias.redirectTarget, "https://perceev.com", "alias redirects to canonical root");
  assert.equal(alias.canonicalHost, "perceev.com");

  // Localhost
  const local = resolveHostPolicy("localhost:3000");
  assert.equal(local.isLocal, true);
  assert.equal(local.isPreferred, false);
  assert.equal(local.redirectTarget, null, "local development does not redirect");
  assert.equal(local.canonicalHost, "perceev.com", "canonical remains production");

  // Preview deployment
  const preview = resolveHostPolicy("perceev-preview-deploy.vercel.app");
  assert.equal(preview.isPreview, true);
  assert.equal(preview.isPreferred, false);
  assert.equal(preview.redirectTarget, null, "preview deployment is not redirected in-app to break testing");
  assert.equal(preview.canonicalHost, "perceev.com");
});

/* ------------------------------------------------------------------ *
 * R20-06 (Level I)
 * ------------------------------------------------------------------ */
test("R20-06 — private portal/account/report routes retain actual access controls independently of indexing directives", () => {
  // Ensure private routes have strict indexing disallow AND require authentication
  const portalPolicy = getRouteIndexingPolicy("/portal/scans");
  assert.equal(portalPolicy.disallowRobots, true);
  assert.equal(portalPolicy.index, false);
  assert.equal(
    portalPolicy.isAuthentication,
    false,
    "robots disallow must NEVER be treated as authentication"
  );

  // Private routes must not be present in public sitemap
  const inventory = getPublicUrlInventory();
  for (const item of inventory) {
    assert.doesNotMatch(item.url, /\/(portal|dashboard|scan|api|login|signup|auth)/);
  }
});

/* ------------------------------------------------------------------ *
 * R20-07 (Level I)
 * ------------------------------------------------------------------ */
test("R20-07 — marketing claim data withholds or limits unverified consumer collection claims and rejects fabricated numbers", () => {
  // Case A: Capability not consumer-qualified -> consumer capture claim withheld
  const unverifiedAttempt = validateMarketingClaims(
    { offersConsumerCapture: true, headline: "Real-time AI overview tracking" },
    { consumerQualified: false }
  );
  assert.equal(unverifiedAttempt.valid, true);
  assert.ok(unverifiedAttempt.withheld.includes("offersConsumerCapture"));
  assert.equal(unverifiedAttempt.claims.offersConsumerCapture, false);
  assert.equal(unverifiedAttempt.claims.consumerCaptureStatus, "unverified");
  assert.match(unverifiedAttempt.claims.consumerCaptureNotice, /experimental and not yet qualified/);

  // Case B: Capability is consumer-qualified -> claim allowed with evidence version
  const qualifiedAttempt = validateMarketingClaims(
    { offersConsumerCapture: true },
    { consumerQualified: true, evidenceVersion: "r12-q2" }
  );
  assert.equal(qualifiedAttempt.valid, true);
  assert.equal(qualifiedAttempt.claims.offersConsumerCapture, true);
  assert.equal(qualifiedAttempt.claims.consumerCaptureStatus, "qualified");
  assert.equal(qualifiedAttempt.claims.evidenceVersion, "r12-q2");

  // Case C: Fabricated numbers (lifetime probe tallies or fake customer stats) rejected
  const fabricatedAttempt = validateMarketingClaims({
    lifetimeProbeCount: 150000,
    customerTestimonialCount: 42,
  });
  assert.equal(fabricatedAttempt.valid, false);
  assert.ok(fabricatedAttempt.errors.some((err) => /Fabricated aggregate probe counts/.test(err)));
});

/* ------------------------------------------------------------------ *
 * Blocked / Manual / Browser / Live acceptance cases (R20-08 to R20-16)
 * Registered with explicit reasons so they are not left unmapped.
 * ------------------------------------------------------------------ */

test(
  "R20-08 — homepage and focused product pages navigation on desktop and mobile",
  { skip: "BLOCKED: requires browser (B) against running Next.js application to test DOM interactions and viewport responsiveness." },
  () => {}
);

test(
  "R20-09 — public page metadata rendered document unique title/description/canonical agreement",
  { skip: "BLOCKED: requires browser (B) to verify rendered DOM elements and open graph tags." },
  () => {}
);

test(
  "R20-10 — sample opened from marketing CTA maintains simulation banner and prevents real mutations",
  { skip: "BLOCKED: requires browser (B) against /demo and sample dashboard sessionStorage." },
  () => {}
);

test(
  "R20-11 — methodology and comparison drafts fact-check against deployed capabilities",
  { skip: "BLOCKED: requires documented human review and rubric adjudication (M)." },
  () => {}
);

test(
  "R20-12 — proposed owned-site study protocol reviewed with real baseline and evaluation window",
  { skip: "BLOCKED: requires human evaluation of pre-registered owned-site study protocol (M)." },
  () => {}
);

test(
  "R20-13 — deployed preferred hostname important public URLs status and canonical check",
  { skip: "BLOCKED: requires deployed live environment check (L) on preferred hostname." },
  () => {}
);

test(
  "R20-14 — deployed alias/preview hostname indexing policy check",
  { skip: "BLOCKED: requires deployed live environment check (L) on preview hostname." },
  () => {}
);

test(
  "R20-15 — authorized Search Console property indexing observations check",
  { skip: "BLOCKED: requires authorized Search Console live property access (L)." },
  () => {}
);

test(
  "R20-16 — keyboard-only user and narrow viewport usability across public routes",
  { skip: "BLOCKED: requires browser (B) with accessibility and keyboard event automation." },
  () => {}
);
