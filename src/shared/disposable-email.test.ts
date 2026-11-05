// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/auth/disposable-email.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DISPOSABLE_EMAIL_DOMAINS,
  emailDomain,
  isDisposableEmailDomain,
} from "./disposable-email.ts";

test("F24-AC-01 - every listed domain is refused, exact and as a subdomain", () => {
  assert.equal(DISPOSABLE_EMAIL_DOMAINS.size, 37);
  for (const domain of DISPOSABLE_EMAIL_DOMAINS) {
    assert.equal(isDisposableEmailDomain(`qa@${domain}`), true, domain);
    assert.equal(isDisposableEmailDomain(`qa@mail.${domain}`), true, `mail.${domain}`);
  }
  assert.equal(isDisposableEmailDomain("qa@a.b.mailinator.com"), true);
});

test("F24-AC-01 - case, surrounding whitespace and a trailing dot are ignored", () => {
  assert.equal(isDisposableEmailDomain("QA@MAILINATOR.COM"), true);
  assert.equal(isDisposableEmailDomain("  qa@mailinator.com  "), true);
  assert.equal(isDisposableEmailDomain("qa@mailinator.com."), true);
});

test("F24-AC-01 - the last @ wins", () => {
  assert.equal(isDisposableEmailDomain("gmail.com@mailinator.com"), true);
  assert.equal(isDisposableEmailDomain("mailinator.com@gmail.com"), false);
});

test("F24-AC-01 - ordinary and look-alike domains pass", () => {
  assert.equal(isDisposableEmailDomain("qa@gmail.com"), false);
  assert.equal(isDisposableEmailDomain("qa@acme.example"), false);
  assert.equal(isDisposableEmailDomain("qa@mailinator.com.evil.example"), false);
  assert.equal(isDisposableEmailDomain("qa@notmailinator.com"), false);
  assert.equal(isDisposableEmailDomain("mailinator.com"), false);
  assert.equal(isDisposableEmailDomain(""), false);
});

test("emailDomain - lower-cases, strips trailing dots, null without @", () => {
  assert.equal(emailDomain("Qa@Example.TEST"), "example.test");
  assert.equal(emailDomain("qa@example.test."), "example.test");
  assert.equal(emailDomain("a@b@c.test"), "c.test");
  assert.equal(emailDomain("no-at-sign"), null);
});

test("seed parity - the SQL seed equals DISPOSABLE_EMAIL_DOMAINS", () => {
  const sql = readFileSync(
    new URL("../../supabase/migrations/155_f24_signup_guard.sql", import.meta.url),
    "utf8",
  );
  const fromSql = [...sql.matchAll(/\('([a-z0-9.-]+)','openseo'\)/g)].map((m) => m[1]);
  assert.deepEqual([...fromSql].sort(), [...DISPOSABLE_EMAIL_DOMAINS].sort());
});
