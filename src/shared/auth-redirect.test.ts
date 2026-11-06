// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/lib/auth-redirect.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_AFTER_SIGN_IN,
  authCallbackUrl,
  buildOnboardingPath,
  normalizeAuthRedirect,
  normalizeHandoffDomain,
  normalizeScanId,
  signInHref,
  verifyEmailHref,
} from "./auth-redirect.ts";

const SCAN = "0c2a4b1e-8d1f-4f35-9b5e-2e0c6f1a7d90";

test("F24-AC-04 - unsafe or missing redirects default to /portal, same-origin paths kept", () => {
  assert.equal(DEFAULT_AFTER_SIGN_IN, "/portal");
  assert.equal(normalizeAuthRedirect(undefined), "/portal");
  assert.equal(normalizeAuthRedirect(null), "/portal");
  assert.equal(normalizeAuthRedirect(""), "/portal");
  assert.equal(normalizeAuthRedirect("https://evil.example/app"), "/portal");
  assert.equal(normalizeAuthRedirect("//evil.example/app"), "/portal");
  assert.equal(normalizeAuthRedirect("/portal/scans?x=1"), "/portal/scans?x=1");
  assert.equal(normalizeAuthRedirect("//evil.example", "/login"), "/login");
});

test("F24-AC-04 - backslash redirects are rejected", () => {
  assert.equal(normalizeAuthRedirect("/\\evil.test"), "/portal");
  assert.equal(normalizeAuthRedirect("/path\\..\\evil"), "/portal");
});

test("F24-AC-04 - tab and newline redirects that URL parsers strip into // are rejected", () => {
  assert.equal(normalizeAuthRedirect("/\t/evil.test"), "/portal");
  assert.equal(normalizeAuthRedirect("/\n/evil.test"), "/portal");
  assert.equal(normalizeAuthRedirect("/\r/evil.test"), "/portal");
});

test("F24-AC-04 - normalizeHandoffDomain", () => {
  assert.equal(normalizeHandoffDomain("https://www.Acme.com/pricing"), "acme.com");
  assert.equal(normalizeHandoffDomain("acme.com:8080/x?y=1"), "acme.com");
  assert.equal(normalizeHandoffDomain("localhost"), null);
  assert.equal(normalizeHandoffDomain("a".repeat(250) + ".com"), null);
  assert.equal(normalizeHandoffDomain("not a domain"), null);
  assert.equal(normalizeHandoffDomain(null), null);
  assert.equal(normalizeHandoffDomain(undefined), null);
});

test("F24-AC-04 - normalizeScanId", () => {
  assert.equal(normalizeScanId("0C2A4B1E-8D1F-4F35-9B5E-2E0C6F1A7D90"), SCAN);
  assert.equal(normalizeScanId("12"), null);
  assert.equal(normalizeScanId(null), null);
});

test("F24-AC-04 - buildOnboardingPath carries only valid params in order", () => {
  assert.equal(
    buildOnboardingPath({ domain: "acme.com", scan: SCAN, redirect: "/portal/scans" }),
    `/onboarding?domain=acme.com&scan=${SCAN}&redirect=%2Fportal%2Fscans`,
  );
  assert.equal(buildOnboardingPath({ redirect: "//evil.test" }), "/onboarding");
  assert.equal(buildOnboardingPath({ redirect: "/portal" }), "/onboarding");
  assert.equal(buildOnboardingPath({ domain: "localhost", scan: "12" }), "/onboarding");
  assert.equal(buildOnboardingPath({}), "/onboarding");
});

test("F24-AC-04 - link builders", () => {
  assert.equal(
    authCallbackUrl("https://app.example.test", "/onboarding?domain=acme.com"),
    "https://app.example.test/auth/callback?next=%2Fonboarding%3Fdomain%3Dacme.com",
  );
  assert.equal(signInHref("/portal"), "/login");
  assert.equal(signInHref("/portal/scans"), "/login?next=%2Fportal%2Fscans");
  assert.equal(verifyEmailHref(null, "/portal"), "/auth/verify");
  assert.equal(
    verifyEmailHref("qa@example.test", "/portal"),
    "/auth/verify?email=qa%40example.test",
  );
  assert.equal(
    verifyEmailHref("qa@example.test", "/portal/scans"),
    "/auth/verify?email=qa%40example.test&next=%2Fportal%2Fscans",
  );
});

test("firstParam: string, repeated key (array) and absent", async () => {
  const { firstParam } = await import("./auth-redirect.ts");
  assert.equal(firstParam("/a"), "/a");
  assert.equal(firstParam(["/a", "/b"]), "/a");
  assert.equal(firstParam([]), "");
  assert.equal(firstParam(undefined), "");
  assert.equal(firstParam(null), "");
});
