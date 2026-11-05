import test from "node:test";
import assert from "node:assert/strict";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, signUpSchema } from "./password.ts";

const base = { email: "owner@example.test", password: "x".repeat(10), confirmPassword: "x".repeat(10) };

function firstIssue(input: unknown) {
  const result = signUpSchema.safeParse(input);
  assert.equal(result.success, false);
  if (result.success) throw new Error("unreachable");
  return result.error.issues[0];
}

test("password limits", () => {
  assert.equal(PASSWORD_MIN_LENGTH, 10);
  assert.equal(PASSWORD_MAX_LENGTH, 128);
});

test("9 characters is too short", () => {
  const pw = "x".repeat(9);
  const issue = firstIssue({ ...base, password: pw, confirmPassword: pw });
  assert.equal(issue.message, "Password must be at least 10 characters.");
  assert.deepEqual(issue.path, ["password"]);
});

test("10 and 128 characters pass; 129 is too long", () => {
  assert.equal(signUpSchema.safeParse(base).success, true);
  const max = "x".repeat(128);
  assert.equal(signUpSchema.safeParse({ ...base, password: max, confirmPassword: max }).success, true);
  const long = "x".repeat(129);
  const issue = firstIssue({ ...base, password: long, confirmPassword: long });
  assert.equal(issue.message, "Password must be at most 128 characters.");
});

test("mismatched confirmation fails on confirmPassword", () => {
  const issue = firstIssue({ ...base, confirmPassword: "y".repeat(10) });
  assert.equal(issue.message, "Passwords do not match.");
  assert.deepEqual(issue.path, ["confirmPassword"]);
});

test("email is trimmed and validated", () => {
  const ok = signUpSchema.safeParse({ ...base, email: " Owner@Example.test " });
  assert.equal(ok.success, true);
  if (ok.success) assert.equal(ok.data.email, "Owner@Example.test");
  const bad = firstIssue({ ...base, email: "not-an-email" });
  assert.equal(bad.message, "Enter a valid email address.");
});
