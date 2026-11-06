import test from "node:test";
import assert from "node:assert/strict";
import { unsubscribeUrl, verifyUnsubscribe, appLink } from "./links.ts";
import { readEmailConfig } from "./config.ts";

test("appLink formats URLs correctly", () => {
  assert.equal(appLink({ appUrl: "https://perceev.com" }, "/portal"), "https://perceev.com/portal");
  assert.equal(appLink({ appUrl: "https://perceev.com/" }, "portal"), "https://perceev.com/portal");
});

test("unsubscribeUrl and verifyUnsubscribe round trip with valid secret", () => {
  const secret = "a-very-long-secret-key-that-is-at-least-32-chars-long";
  const cfg = readEmailConfig({
    EMAIL_LINK_SECRET: secret,
    NEXT_PUBLIC_APP_URL: "https://app.perceev.com",
  });

  const userId = "00000000-0000-0000-0000-000000000001";
  const category = "scan_results";

  const urlStr = unsubscribeUrl(cfg, userId, category);
  assert.ok(urlStr.startsWith("https://app.perceev.com/email/unsubscribe?"));

  const parsed = new URL(urlStr);
  const u = parsed.searchParams.get("u")!;
  const c = parsed.searchParams.get("c")!;
  const t = parsed.searchParams.get("t")!;

  assert.equal(u, userId);
  assert.equal(c, category);
  assert.ok(t.length >= 40);

  // Verification succeeds
  assert.equal(verifyUnsubscribe(cfg, u, c, t), true);

  // Changed user fails
  assert.equal(verifyUnsubscribe(cfg, "00000000-0000-0000-0000-000000000002", c, t), false);

  // Changed category fails
  assert.equal(verifyUnsubscribe(cfg, u, "schedule_alerts", t), false);

  // One character tampered token fails
  const tamperedChar = t[0] === "a" ? "b" : "a";
  const tamperedToken = tamperedChar + t.slice(1);
  assert.equal(verifyUnsubscribe(cfg, u, c, tamperedToken), false);
});

test("missing or short secret falls back to settings URL and verify returns false", () => {
  // Secret missing
  const cfgMissing = readEmailConfig({
    NEXT_PUBLIC_APP_URL: "https://app.perceev.com",
  });
  assert.equal(
    unsubscribeUrl(cfgMissing, "user-1", "scan_results"),
    "https://app.perceev.com/portal/settings/notifications",
  );
  assert.equal(verifyUnsubscribe(cfgMissing, "user-1", "scan_results", "some-token"), false);

  // Secret too short (< 32 chars)
  const cfgShort = readEmailConfig({
    EMAIL_LINK_SECRET: "too-short",
    NEXT_PUBLIC_APP_URL: "https://app.perceev.com",
  });
  assert.equal(cfgShort.linkSecret, null);
  assert.equal(
    unsubscribeUrl(cfgShort, "user-1", "scan_results"),
    "https://app.perceev.com/portal/settings/notifications",
  );
  assert.equal(verifyUnsubscribe(cfgShort, "user-1", "scan_results", "some-token"), false);
});
