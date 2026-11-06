import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  authErrorCodeFrom,
  authErrorCopy,
  signInErrorMessage,
  signUpErrorMessage,
} from "./auth-errors.ts";

type Fixture = { name: string; query: string; expected: string };
const fixtures: Fixture[] = JSON.parse(
  readFileSync(new URL("../../tests/fixtures/f24/oauth-errors.json", import.meta.url), "utf8"),
);

test("F24-AC-10 - every fixture query maps to its code", () => {
  assert.equal(fixtures.length, 5);
  for (const f of fixtures) {
    const params = new URLSearchParams(f.query);
    assert.equal(
      authErrorCodeFrom({
        error: params.get("error"),
        errorCode: params.get("error_code"),
        description: params.get("error_description"),
      }),
      f.expected,
      f.name,
    );
  }
});

test("F24-AC-10 - authErrorCodeFrom: one case per code and precedence", () => {
  assert.equal(authErrorCodeFrom({ error: "access_denied" }), "access_denied");
  assert.equal(
    authErrorCodeFrom({ description: "Please sign up with a Non-Disposable email address." }),
    "disposable_email",
  );
  assert.equal(authErrorCodeFrom({ description: "CAPTCHA verification failed" }), "captcha_failed");
  assert.equal(authErrorCodeFrom({ errorCode: "signup_disabled" }), "signup_disabled");
  assert.equal(authErrorCodeFrom({ errorCode: "bad_oauth_state" }), "state_mismatch");
  assert.equal(
    authErrorCodeFrom({ error: "invalid_request", description: "invalid state parameter" }),
    "state_mismatch",
  );
  assert.equal(authErrorCodeFrom({ errorCode: "otp_expired" }), "link_expired");
  assert.equal(authErrorCodeFrom({ errorCode: "flow_state_expired" }), "link_expired");
  assert.equal(authErrorCodeFrom({}), "unknown");
  assert.equal(authErrorCodeFrom({ error: null, errorCode: null, description: null }), "unknown");
  // An expired email link arrives as access_denied + otp_expired: link_expired wins.
  assert.equal(
    authErrorCodeFrom({ error: "access_denied", errorCode: "otp_expired", description: "Email link is invalid or has expired" }),
    "link_expired",
  );
  // access_denied wins over a disposable description.
  assert.equal(
    authErrorCodeFrom({ error: "access_denied", description: "non-disposable" }),
    "access_denied",
  );
});

test("isAuthErrorCode accepts only the closed set", async () => {
  const { isAuthErrorCode } = await import("./auth-errors.ts");
  for (const code of ["access_denied", "state_mismatch", "disposable_email", "captcha_failed", "signup_disabled", "link_expired", "unknown"]) {
    assert.equal(isAuthErrorCode(code), true, code);
  }
  for (const v of ["Account locked - call support", "", null, undefined, ["access_denied"]]) {
    assert.equal(isAuthErrorCode(v), false, String(v));
  }
});

test("F24-AC-10 - authErrorCopy returns the section 6.6 copy for each code and a default", () => {
  assert.deepEqual(authErrorCopy("access_denied"), {
    title: "Google sign-in was canceled",
    description:
      "Google's permission screen was closed or declined. Try again whenever you're ready.",
  });
  assert.equal(authErrorCopy("state_mismatch").title, "Google sign-in didn't finish");
  assert.match(authErrorCopy("state_mismatch").description, /within 10 minutes/);
  assert.deepEqual(authErrorCopy("disposable_email"), {
    title: "Use a work email address",
    description: "Please sign up with a non-disposable email address.",
  });
  assert.equal(authErrorCopy("captcha_failed").title, "The security check didn't pass");
  assert.match(authErrorCopy("captcha_failed").description, /challenges\.cloudflare\.com/);
  assert.equal(authErrorCopy("signup_disabled").title, "Sign-ups are closed");
  assert.deepEqual(authErrorCopy("link_expired"), {
    title: "That link has expired",
    description: "Request a new email from the sign-in page.",
  });
  for (const code of ["unknown", "something_else", ""]) {
    assert.equal(authErrorCopy(code).title, "Sign-in didn't finish", code);
    assert.match(authErrorCopy(code).description, /contact support\.$/);
  }
});

test("signInErrorMessage - one case per kind", () => {
  const credentials = "That email and password did not match. Check them and try again.";
  assert.deepEqual(signInErrorMessage({ code: "invalid_credentials" }), {
    kind: "invalid_credentials",
    message: credentials,
  });
  assert.deepEqual(signInErrorMessage({ message: "Invalid login credentials" }), {
    kind: "invalid_credentials",
    message: credentials,
  });
  assert.equal(signInErrorMessage({ code: "email_not_confirmed" }).kind, "unconfirmed");
  assert.deepEqual(signInErrorMessage({ message: "captcha protection: request disallowed" }), {
    kind: "captcha",
    message: "The security check didn't pass. Try again.",
  });
  const limited = "Too many attempts. Wait a minute and try again.";
  assert.deepEqual(signInErrorMessage({ status: 429 }), { kind: "rate_limited", message: limited });
  assert.deepEqual(signInErrorMessage({ code: "over_request_rate_limit" }), {
    kind: "rate_limited",
    message: limited,
  });
  const other = { kind: "other", message: "We could not sign you in. Please try again." };
  assert.deepEqual(signInErrorMessage({ message: "boom" }), other);
  assert.deepEqual(signInErrorMessage(null), other);
});

test("signUpErrorMessage - one case per kind", () => {
  assert.deepEqual(
    signUpErrorMessage({ message: "Please sign up with a non-disposable email address." }),
    { kind: "disposable", message: "Please sign up with a non-disposable email address." },
  );
  assert.deepEqual(signUpErrorMessage({ message: "Captcha verification process failed" }), {
    kind: "captcha",
    message: "The security check didn't pass. Try again.",
  });
  assert.deepEqual(signUpErrorMessage({ code: "user_already_exists" }), {
    kind: "exists",
    message: "An account with this email already exists. Sign in instead.",
  });
  assert.deepEqual(signUpErrorMessage({ code: "weak_password" }), {
    kind: "weak_password",
    message: "Choose a stronger password: at least 10 characters.",
  });
  assert.deepEqual(signUpErrorMessage({ status: 429 }), {
    kind: "rate_limited",
    message: "Too many attempts. Wait a minute and try again.",
  });
  const other = {
    kind: "other",
    message: "We could not create your account. Check the email and password and try again.",
  };
  assert.deepEqual(signUpErrorMessage({ message: "boom" }), other);
  assert.deepEqual(signUpErrorMessage(null), other);
});
