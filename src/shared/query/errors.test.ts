// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/lib/error-messages.ts
//   src/client/lib/error-messages.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.
//
// F05-AC-03 (unit half) — spend-refusal classification and view, and
// `describeError`. Browser case F05-B06 is Phase 3.
import test from "node:test";
import assert from "node:assert/strict";
import {
  SPEND_REFUSAL_CODES,
  describeError,
  isSpendRefused,
  spendRefusedView,
} from "./errors.ts";
import { ApiError } from "./fetchJson.ts";

test("describeError returns an ApiError's message", () => {
  assert.equal(
    describeError(new ApiError(400, "validation_error", "Name is required.")),
    "Name is required.",
  );
});

test("describeError returns a plain Error's message (custom, non-code)", () => {
  assert.equal(
    describeError(new Error("Something failed: try again")),
    "Something failed: try again",
  );
});

test("describeError uses the fallback for an Error with an empty message", () => {
  assert.equal(describeError(new Error(""), "Custom fallback"), "Custom fallback");
  assert.equal(
    describeError(new Error("")),
    "Something went wrong. Please try again.",
  );
});

test("describeError uses the fallback for non-Errors, including thrown strings", () => {
  assert.equal(describeError("boom", "Custom fallback"), "Custom fallback");
  assert.equal(describeError(undefined, "Custom fallback"), "Custom fallback");
  assert.equal(describeError(null, "Custom fallback"), "Custom fallback");
  assert.equal(describeError({ message: "x" }, "Custom fallback"), "Custom fallback");
});

test("describeError default fallback is the spec text", () => {
  assert.equal(describeError("boom"), "Something went wrong. Please try again.");
  assert.equal(describeError(undefined), "Something went wrong. Please try again.");
});

test("SPEND_REFUSAL_CODES is exactly the four spec codes", () => {
  assert.deepEqual(
    [...SPEND_REFUSAL_CODES],
    ["feature_disabled", "daily_cap", "workspace_cap", "over_approved_max"],
  );
});

test("isSpendRefused is true only for an ApiError with a spend-refusal code", () => {
  for (const code of SPEND_REFUSAL_CODES) {
    assert.equal(isSpendRefused(new ApiError(403, code, "m")), true, code);
  }
  assert.equal(isSpendRefused(new ApiError(400, "validation_error", "m")), false);
  assert.equal(isSpendRefused(new ApiError(401, "unauthenticated", "m")), false);
  // A plain Error or lookalike object with a spend code is not an ApiError.
  assert.equal(isSpendRefused(Object.assign(new Error("m"), { code: "daily_cap" })), false);
  assert.equal(isSpendRefused({ code: "daily_cap", status: 403 }), false);
  assert.equal(isSpendRefused(null), false);
  assert.equal(isSpendRefused("daily_cap"), false);
});

test("spendRefusedView: titles, usage link and message per code", () => {
  const expected = {
    feature_disabled: ["Not available for this workspace", false],
    daily_cap: ["Daily spend limit reached", true],
    workspace_cap: ["Monthly spend limit reached", true],
    over_approved_max: ["The price changed", false],
  } as const;
  for (const code of SPEND_REFUSAL_CODES) {
    const err = new ApiError(403, code, `API says ${code}.`);
    if (!isSpendRefused(err)) throw new Error("expected spend refusal");
    const view = spendRefusedView(err);
    assert.equal(view.title, expected[code][0], code);
    assert.equal(view.showUsageLink, expected[code][1], code);
    assert.equal(view.message, `API says ${code}.`, code);
    assert.equal(view.recovery, null, code);
    assert.equal(view.text, `API says ${code}.`, code);
  }
});

test("spendRefusedView passes the API recovery through, or null", () => {
  const withRecovery = new ApiError(403, "daily_cap", "Limit hit.", {
    recovery: "Try again tomorrow.",
  });
  if (!isSpendRefused(withRecovery)) throw new Error("expected spend refusal");
  assert.deepEqual(spendRefusedView(withRecovery), {
    title: "Daily spend limit reached",
    message: "Limit hit.",
    recovery: "Try again tomorrow.",
    text: "Limit hit. Try again tomorrow.",
    showUsageLink: true,
  });
});
