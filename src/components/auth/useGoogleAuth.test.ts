import test from "node:test";
import assert from "node:assert/strict";
import { buildGoogleOAuthOptions } from "./useGoogleAuth.ts";

test("F24-AC-08 - buildGoogleOAuthOptions constructs valid OAuth authorize options", () => {
  const options = buildGoogleOAuthOptions(
    "https://app.example.test",
    "/onboarding?domain=acme.com"
  );

  assert.equal(options.provider, "google");
  assert.equal(
    options.options.redirectTo,
    "https://app.example.test/auth/callback?next=%2Fonboarding%3Fdomain%3Dacme.com"
  );
  assert.deepEqual(options.options.queryParams, { prompt: "select_account" });
});

test("F24-AC-08 - buildGoogleOAuthOptions handles simple /portal redirect", () => {
  const options = buildGoogleOAuthOptions("http://localhost:3000", "/portal");
  assert.equal(
    options.options.redirectTo,
    "http://localhost:3000/auth/callback?next=%2Fportal"
  );
  assert.deepEqual(options.options.queryParams, { prompt: "select_account" });
});
