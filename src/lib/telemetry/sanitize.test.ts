import test from "node:test";
import assert from "node:assert/strict";
import { isErrorCode, sanitizeEvent, sanitizePostHogUrl } from "./sanitize.ts";

test("F26-AC-06 keeps allow-listed query params only", () => {
  assert.equal(
    sanitizePostHogUrl("/portal/scans?brand_key=acme.test&tab=answers&utm_source=x"),
    "/portal/scans?tab=answers&utm_source=x",
  );
  assert.equal(
    sanitizePostHogUrl("/onboarding?step=2&domain=acme.com&scan=x"),
    "/onboarding?step=2",
  );
  assert.equal(sanitizePostHogUrl("/auth/callback?code=abc&next=%2F"), "/auth/callback");
  assert.equal(sanitizePostHogUrl("/portal?view=list&range=7d#secret"), "/portal?view=list&range=7d");
});

test("F26-AC-06 blanks exception messages that are not codes", () => {
  const e = sanitizeEvent({
    event: "$exception",
    properties: {
      $exception_list: [{ value: "Failed for acme.test" }, { value: "internal_error" }],
      $exception_message: "boom at snitch.com",
    },
  });
  const list = e?.properties?.$exception_list as Array<{ value: string }>;
  assert.equal(list[0].value, "");
  assert.equal(list[1].value, "internal_error");
  assert.equal(e?.properties?.$exception_message, "");
  assert.equal(isErrorCode("internal_error"), true);
  assert.equal(isErrorCode("site_audit.run"), false);
});

test("F26-AC-06 removes external click urls", () => {
  const e = sanitizeEvent({
    event: "$autocapture",
    properties: { $external_click_url: "https://acme.test/x", href: "https://acme.test/y" },
  });
  assert.equal(e?.properties?.$external_click_url, undefined);
  assert.equal(e?.properties?.href, "https://acme.test/y"); // cleaned via nested — origin kept without path secrets
});
