import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "../http/appError.ts";
import {
  parseResearchTargetOrThrow,
  toRelativePath,
  normalizeDomainInput,
} from "./target.ts";

test("parseResearchTargetOrThrow parses valid targets correctly", () => {
  const target = parseResearchTargetOrThrow("https://www.Example.com/blog/");
  assert.equal(target.scope, "subfolder");
  assert.equal(target.hostname, "example.com");
  assert.equal(target.urlHostname, "www.example.com");
  assert.equal(target.path, "/blog");
  assert.equal(target.display, "example.com/blog");
});

test("parseResearchTargetOrThrow rejects invalid targets with AppError(400, invalid_target)", () => {
  // example.por rejected
  assert.throws(
    () => parseResearchTargetOrThrow("example.por"),
    (err: unknown) =>
      err instanceof AppError &&
      err.status === 400 &&
      err.code === "invalid_target" &&
      err.message === "Enter a valid domain like example.com",
  );

  // credentials rejected
  assert.throws(
    () => parseResearchTargetOrThrow("https://user:pass@example.com/blog"),
    (err: unknown) =>
      err instanceof AppError &&
      err.status === 400 &&
      err.code === "invalid_target" &&
      err.message === "URLs with embedded credentials are not supported",
  );

  // empty input rejected
  assert.throws(
    () => parseResearchTargetOrThrow(""),
    (err: unknown) =>
      err instanceof AppError &&
      err.status === 400 &&
      err.code === "invalid_target",
  );
});

test("toRelativePath extracts path and query string", () => {
  assert.equal(toRelativePath("https://example.com/blog/article?ref=1"), "/blog/article?ref=1");
  assert.equal(toRelativePath("https://example.com"), "/");
  assert.equal(toRelativePath(null), null);
  assert.equal(toRelativePath(undefined), null);
  assert.equal(toRelativePath("not-a-url"), null);
});

test("normalizeDomainInput strips protocol and validates domain", () => {
  assert.equal(normalizeDomainInput("https://www.Example.com", true), "example.com");
  assert.equal(normalizeDomainInput("sub.example.com", true), "sub.example.com");
  assert.equal(normalizeDomainInput("sub.example.com", false), "example.com");

  assert.throws(
    () => normalizeDomainInput("", true),
    (err: unknown) => err instanceof AppError && err.status === 400 && err.code === "invalid_target",
  );
  assert.throws(
    () => normalizeDomainInput("example.por", true),
    (err: unknown) => err instanceof AppError && err.status === 400 && err.code === "invalid_target",
  );
});
