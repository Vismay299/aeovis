import test from "node:test";
import assert from "node:assert/strict";
import { readIdTokenClaims } from "./idToken.ts";

function createIdToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.mock-signature`;
}

test("readIdTokenClaims: successfully reads sub and email for valid token", () => {
  const now = 1700000000000;
  const token = createIdToken({
    iss: "https://accounts.google.com",
    aud: "test-client-id",
    sub: "google-sub-12345",
    email: "user@example.com",
    exp: Math.floor(now / 1000) + 3600,
  });

  const claims = readIdTokenClaims(token, "test-client-id", now);
  assert.equal(claims.sub, "google-sub-12345");
  assert.equal(claims.email, "user@example.com");
});

test("readIdTokenClaims: accepts accounts.google.com issuer and array audience", () => {
  const now = 1700000000000;
  const token = createIdToken({
    iss: "accounts.google.com",
    aud: ["other-client", "test-client-id"],
    sub: "google-sub-12345",
    exp: Math.floor(now / 1000) + 1000,
  });

  const claims = readIdTokenClaims(token, "test-client-id", now);
  assert.equal(claims.sub, "google-sub-12345");
  assert.equal(claims.email, null);
});

test("readIdTokenClaims: rejects invalid issuer", () => {
  const now = 1700000000000;
  const token = createIdToken({
    iss: "https://evil.com",
    aud: "test-client-id",
    sub: "sub",
    exp: Math.floor(now / 1000) + 3600,
  });

  assert.throws(() => readIdTokenClaims(token, "test-client-id", now), /Invalid id_token issuer/);
});

test("readIdTokenClaims: rejects mismatched audience", () => {
  const now = 1700000000000;
  const token = createIdToken({
    iss: "https://accounts.google.com",
    aud: "other-client-id",
    sub: "sub",
    exp: Math.floor(now / 1000) + 3600,
  });

  assert.throws(() => readIdTokenClaims(token, "test-client-id", now), /Invalid id_token audience/);
});

test("readIdTokenClaims: rejects expired token", () => {
  const now = 1700000000000;
  const token = createIdToken({
    iss: "https://accounts.google.com",
    aud: "test-client-id",
    sub: "sub",
    exp: Math.floor(now / 1000) - 10,
  });

  assert.throws(() => readIdTokenClaims(token, "test-client-id", now), /id_token has expired/);
});

test("readIdTokenClaims: rejects missing or empty sub", () => {
  const now = 1700000000000;
  const token = createIdToken({
    iss: "https://accounts.google.com",
    aud: "test-client-id",
    sub: "",
    exp: Math.floor(now / 1000) + 3600,
  });

  assert.throws(() => readIdTokenClaims(token, "test-client-id", now), /Missing or empty id_token sub/);
});

test("readIdTokenClaims: rejects malformed token", () => {
  assert.throws(() => readIdTokenClaims("not-a-token", "test-client-id"), /Malformed id_token/);
  assert.throws(() => readIdTokenClaims("", "test-client-id"), /Missing or invalid id_token/);
});
