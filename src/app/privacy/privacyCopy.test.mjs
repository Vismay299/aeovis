import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
