import test from "node:test";
import assert from "node:assert/strict";
import { isErrorCode, sanitizeEvent, sanitizePostHogEvent, sanitizePostHogUrl } from "./sanitize.ts";

test("F26-AC-06 sanitizePostHogUrl drops content query params and keeps allowlisted ones", () => {
  assert.equal(
    sanitizePostHogUrl(
      "https://app.example.test/p/abc/keywords?q=running+shoes&utm_source=newsletter#row",
    ),
    "https://app.example.test/p/abc/keywords?utm_source=newsletter",
  );
  assert.equal(
    sanitizePostHogUrl("/p/abc/domain?domain=acme.test&tab=pages"),
    "/p/abc/domain?tab=pages",
  );
  assert.equal(
    sanitizePostHogUrl("/portal/scans?brand_key=acme.test&tab=answers"),
    "/portal/scans?tab=answers",
  );
  assert.equal(
    sanitizePostHogUrl("/onboarding?step=2&domain=acme.com&scan=x"),
    "/onboarding?step=2",
  );
  assert.equal(
    sanitizePostHogUrl("/auth/callback?code=abc&next=%2F"),
    "/auth/callback",
  );
  assert.equal(
    sanitizePostHogUrl("/portal?view=list&range=7d#secret"),
    "/portal?view=list&range=7d",
  );
});

test("F26-AC-06 sanitizes event and person URLs and removes autocaptured link targets", () => {
  const url = "https://app.example.test/oauth-consent?state=secret";
  const sanitized = sanitizePostHogEvent({
    properties: {
      $current_url: url,
      $external_click_url: "https://customer.test/page",
      $elements_chain: 'a:attr__href="https://customer.test/page"nth-child="1"',
    },
    $set_once: { $initial_current_url: url },
  });

  assert.deepEqual(sanitized, {
    properties: {
      $current_url: "https://app.example.test/oauth-consent",
      $elements_chain: 'a:nth-child="1"',
    },
    $set_once: {
      $initial_current_url: "https://app.example.test/oauth-consent",
    },
  });
});

test("F26-AC-06 sanitizes URLs nested in web vitals and used as heatmap keys", () => {
  const sanitized = sanitizePostHogEvent({
    properties: {
      $web_vitals_LCP_event: {
        $current_url: "https://app.example.test/p/abc?q=running+shoes",
      },
      $heatmap_data: {
        "https://app.example.test/p/abc?domain=acme.test&tab=x": [{ x: 1 }],
        "https://app.example.test/p/abc?domain=other.test&tab=x": [{ x: 2 }],
      },
    },
  });

  assert.deepEqual(sanitized.properties, {
    $web_vitals_LCP_event: { $current_url: "https://app.example.test/p/abc" },
    $heatmap_data: {
      "https://app.example.test/p/abc?tab=x": [{ x: 1 }, { x: 2 }],
    },
  });
});

test("F26-AC-06 blanks exception messages that are not codes", () => {
  const e = sanitizeEvent({
    event: "$exception",
    properties: {
      $exception_list: [
        { type: "SyntaxError", value: `"running shoes" is not valid JSON` },
        { type: "Error", value: "internal_error" },
        { type: "Error", value: "PAYMENT_REQUIRED" },
      ],
      $exception_message: "boom at snitch.com",
    },
  });
  const list = e?.properties?.$exception_list as Array<{ type: string; value: string }>;
  assert.equal(list[0].value, "");
  assert.equal(list[1].value, "internal_error");
  assert.equal(list[2].value, "PAYMENT_REQUIRED");
  assert.equal(e?.properties?.$exception_message, "");
  assert.equal(isErrorCode("internal_error"), true);
  assert.equal(isErrorCode("PAYMENT_REQUIRED"), true);
  assert.equal(isErrorCode("site_audit.run"), false);
});

test("F26-AC-06 drops URLs it cannot parse and non-web schemes instead of passing them through", () => {
  assert.equal(sanitizePostHogUrl("see https://acme.test/x?token=secret"), "");
  assert.equal(sanitizePostHogUrl("mailto:owner@acme.test"), "");
  const e = sanitizeEvent({ properties: { href: "relative/page?token=secret" } });
  assert.equal(e?.properties?.href, "");
});
