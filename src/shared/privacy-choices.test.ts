import test from "node:test";
import assert from "node:assert/strict";
import {
  PRIVACY_COOKIE,
  effectiveAnalyticsChoice,
  hasGlobalPrivacyControl,
  readPrivacyCookie,
  writePrivacyCookie,
} from "./privacy-choices.ts";

test("F26-AC-07 readPrivacyCookie a1/a0/null", () => {
  assert.equal(readPrivacyCookie(`${PRIVACY_COOKIE}=a1`), true);
  assert.equal(readPrivacyCookie(`foo=1; ${PRIVACY_COOKIE}=a0; bar=2`), false);
  assert.equal(readPrivacyCookie("other=1"), null);
  assert.equal(readPrivacyCookie(null), null);
});

test("F26-AC-07 effectiveAnalyticsChoice precedence: account > cookie > default false", () => {
  assert.equal(effectiveAnalyticsChoice({ account: true, cookie: false, gpc: false }), true);
  assert.equal(effectiveAnalyticsChoice({ account: false, cookie: true, gpc: false }), false);
  assert.equal(effectiveAnalyticsChoice({ account: null, cookie: true, gpc: false }), true);
  assert.equal(effectiveAnalyticsChoice({ account: null, cookie: null, gpc: false }), false);
});

test("F26-AC-07 GPC with no explicit decision → false", () => {
  assert.equal(effectiveAnalyticsChoice({ account: null, cookie: null, gpc: true }), false);
  // Explicit account opt-in still wins over GPC (Settings "turn it on here")
  assert.equal(effectiveAnalyticsChoice({ account: true, cookie: null, gpc: true }), true);
});

test("F26-AC-07 DNT is not GPC — explicit consent is independent of DNT", () => {
  // Documented contract: DNT must not flip effective choice; client uses respect_dnt: false.
  assert.equal(effectiveAnalyticsChoice({ account: true, cookie: null, gpc: false }), true);
  assert.equal(hasGlobalPrivacyControl({ globalPrivacyControl: true }), true);
  assert.equal(hasGlobalPrivacyControl({ globalPrivacyControl: false }), false);
  assert.equal(hasGlobalPrivacyControl({}), false);
});

test("writePrivacyCookie sets a1/a0 with SameSite=Lax", () => {
  const jar = { cookie: "", location: { protocol: "https:" } };
  writePrivacyCookie(true, jar);
  assert.match(jar.cookie, new RegExp(`${PRIVACY_COOKIE}=a1`));
  assert.match(jar.cookie, /SameSite=Lax/);
  assert.match(jar.cookie, /Secure/);
  writePrivacyCookie(false, jar);
  assert.match(jar.cookie, new RegExp(`${PRIVACY_COOKIE}=a0`));
});
