import test from "node:test";
import assert from "node:assert/strict";
import {
  PRIVACY_COOKIE,
  effectiveAnalyticsChoice,
  hasGlobalPrivacyControl,
  readPrivacyCookie,
  writePrivacyCookie,
  clearPrivacyCookie,
} from "./privacy-choices.ts";

test("F26-AC-07 readPrivacyCookie a1/a0/null", () => {
  assert.equal(readPrivacyCookie(`${PRIVACY_COOKIE}=a1`), true);
  assert.equal(readPrivacyCookie(`foo=1; ${PRIVACY_COOKIE}=a0; bar=2`), false);
  assert.equal(readPrivacyCookie("other=1"), null);
  assert.equal(readPrivacyCookie(null), null);
});

test("F26-AC-07 effectiveAnalyticsChoice precedence: account > cookie > default false", () => {
  assert.equal(effectiveAnalyticsChoice({ account: true, cookie: false, signedIn: true, gpc: false }), true);
  assert.equal(effectiveAnalyticsChoice({ account: false, cookie: true, signedIn: true, gpc: false }), false);
  assert.equal(effectiveAnalyticsChoice({ account: null, cookie: true, signedIn: false, gpc: false }), true);
  assert.equal(effectiveAnalyticsChoice({ account: null, cookie: null, signedIn: false, gpc: false }), false);
});

test("F26-AC-07 a signed-in undecided account ignores a leftover cookie", () => {
  // One shared browser: the previous person's "yes" must not opt the next account in.
  assert.equal(effectiveAnalyticsChoice({ account: null, cookie: true, signedIn: true, gpc: false }), false);
  assert.equal(effectiveAnalyticsChoice({ account: null, cookie: false, signedIn: true, gpc: false }), false);
});

test("F26-AC-07 GPC with no explicit decision → false", () => {
  assert.equal(effectiveAnalyticsChoice({ account: null, cookie: null, signedIn: false, gpc: true }), false);
  // Explicit account opt-in still wins over GPC (Settings "turn it on here")
  assert.equal(effectiveAnalyticsChoice({ account: true, cookie: null, signedIn: true, gpc: true }), true);
});

test("F26-AC-07 DNT defaults an undecided answer to off but never overrides consent", () => {
  assert.equal(hasGlobalPrivacyControl({ globalPrivacyControl: true }), true);
  assert.equal(hasGlobalPrivacyControl({ doNotTrack: "1" }), true);
  assert.equal(hasGlobalPrivacyControl({ globalPrivacyControl: false, doNotTrack: "0" }), false);
  assert.equal(hasGlobalPrivacyControl({}), false);
  // The client keeps respect_dnt: false, so an explicit opt-in is honoured for a DNT browser.
  assert.equal(effectiveAnalyticsChoice({ account: true, cookie: null, signedIn: true, gpc: true }), true);
});

test("clearPrivacyCookie expires the cookie", () => {
  const jar = { cookie: "" };
  clearPrivacyCookie(jar);
  assert.match(jar.cookie, new RegExp(`${PRIVACY_COOKIE}=;`));
  assert.match(jar.cookie, /Max-Age=0/);
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
