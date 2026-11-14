import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { POLICY_VERSION } from "../../lib/telemetry/events.ts";

const privacyFile = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "page.jsx"
);

test("F24-AC-15 - privacy policy contains Google Sign-in and Cloudflare Turnstile disclosures", () => {
  const content = fs.readFileSync(privacyFile, "utf8");

  const expectedGoogleSection =
    "If you choose Continue with Google, Google shares your name, email address and Google account identifier with Perceev so we can create and secure your account. Perceev does not receive your Google password, and signing in with Google does not give Perceev access to your Search Console or Analytics data; those connections ask for separate permission.";

  const expectedTurnstileSentence =
    "Sign-up, sign-in and password-reset forms use Cloudflare Turnstile to block automated abuse; Cloudflare processes technical information from your browser for this check.";

  assert.ok(
    content.includes(expectedGoogleSection),
    "Expected privacy policy to contain Google Sign-in section"
  );
  assert.ok(
    content.includes(expectedTurnstileSentence),
    "Expected privacy policy to name Cloudflare Turnstile as abuse protection provider"
  );
  assert.ok(
    content.includes('id="google-sign-in"'),
    "Expected google-sign-in section id"
  );
});

test("F26-AC-15 - privacy policy contains Product analytics and error reports section matching §6.7 and POLICY_VERSION", () => {
  const content = fs.readFileSync(privacyFile, "utf8");

  assert.ok(
    content.includes('id="analytics"'),
    "Expected analytics section id"
  );
  assert.ok(
    content.includes("Product analytics and error reports"),
    "Expected Product analytics and error reports heading"
  );

  const firstSentence = "If you turn on usage analytics (it is off until you do)";
  assert.ok(
    content.includes(firstSentence),
    `Expected first sentence to include "${firstSentence}"`
  );

  assert.ok(
    /When usage analytics is on, PostHog stores an identifier in your browser;\s*a small Perceev\s*cookie remembers your choice\./.test(content),
    "Expected cookie sentence in analytics policy"
  );

  // Policy page's own last updated date equals POLICY_VERSION
  assert.ok(
    content.includes(`Last updated: {POLICY_VERSION}`) || content.includes(POLICY_VERSION),
    `Expected policy page last updated date to equal POLICY_VERSION (${POLICY_VERSION})`
  );
});

test("F25-AC-15 - privacy policy contains the Loops email paragraph (§6.7, first sentence)", () => {
  const content = fs.readFileSync(privacyFile, "utf8");
  const normalized = content.replace(/\s+/g, " ");

  const firstSentence =
    "We use Loops to send account emails: notifications about your workspace (for example when a scan finishes), a short series of setup tips after you sign up, and product updates only if you opt in.";

  assert.ok(
    normalized.includes(firstSentence),
    "Expected privacy policy to contain the F25 Loops email first sentence"
  );
});
