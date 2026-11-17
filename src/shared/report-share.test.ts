import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SHARE_TOKEN_PATTERN,
  mintShareToken,
  sharePath,
  sharePseudonym,
} from "./report-share.ts";

// F23-AC-10 unit half: the token is 32 base64url characters from 24 random
// bytes, and the anonymous view pseudonym is derived from the token without
// being the token.

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

test("mints 32 base64url characters", () => {
  for (let i = 0; i < 50; i += 1) {
    const token = mintShareToken();
    assert.equal(token.length, 32, `token ${token} must be 32 characters`);
    assert.match(token, SHARE_TOKEN_PATTERN);
    for (const char of token) {
      assert.ok(BASE64URL_ALPHABET.includes(char), `unexpected character ${char} in ${token}`);
    }
  }
});

test("no two of 1,000 mints collide", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1_000; i += 1) seen.add(mintShareToken());
  assert.equal(seen.size, 1_000, "the mint must be random, not derived from a counter");
});

test("the shape check accepts what the mint produces and rejects everything else", () => {
  assert.match(mintShareToken(), SHARE_TOKEN_PATTERN);
  for (const bad of [
    "",
    "short",
    "a".repeat(31),
    "a".repeat(33),
    "a".repeat(31) + "+",
    "a".repeat(31) + "/",
    "a".repeat(31) + "=",
    "a".repeat(31) + " ",
  ]) {
    assert.equal(SHARE_TOKEN_PATTERN.test(bad), false, `must reject ${JSON.stringify(bad)}`);
  }
});

test("sharePath is the one public path shape", () => {
  const token = mintShareToken();
  assert.equal(sharePath(token), `/s/${token}`);
});

test("the pseudonym is share: plus 16 hex characters and never the token", async () => {
  const token = mintShareToken();
  const pseudonym = await sharePseudonym(token);
  assert.match(pseudonym, /^share:[0-9a-f]{16}$/);
  assert.notEqual(pseudonym, token);
  assert.equal(pseudonym.includes(token), false);
  // Stable for the same link, different for a different link.
  assert.equal(await sharePseudonym(token), pseudonym);
  assert.notEqual(await sharePseudonym(mintShareToken()), pseudonym);
});

test("the pseudonym is the documented SHA-256 prefix, recomputed here", async () => {
  // One fixed token, so this is the published rule rather than a restatement of
  // the implementation: sha256(token) in hex, first 16 characters.
  const token = "a".repeat(32);
  const expected = "share:3ba3f5f43b926026";
  const { createHash } = await import("node:crypto");
  const hex = createHash("sha256").update(token).digest("hex");
  assert.equal(await sharePseudonym(token), `share:${hex.slice(0, 16)}`);
  assert.equal(await sharePseudonym(token), expected);
});
