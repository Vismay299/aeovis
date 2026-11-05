// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/integrations/googleAuthErrorCopy.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

export type AuthErrorCode =
  | "access_denied"
  | "state_mismatch"
  | "disposable_email"
  | "captcha_failed"
  | "signup_disabled"
  | "link_expired"
  | "unknown";

/**
 * Map the error parameters Supabase Auth puts on our callback URL to one of
 * our closed codes. The code (never the raw description) is what travels to
 * /auth/error.
 */
export function authErrorCodeFrom(i: {
  error?: string | null;
  errorCode?: string | null;
  description?: string | null;
}): AuthErrorCode {
  const description = (i.description ?? "").toLowerCase();
  if (i.error === "access_denied") return "access_denied";
  if (description.includes("non-disposable")) return "disposable_email";
  if (description.includes("captcha")) return "captcha_failed";
  if (i.errorCode === "signup_disabled") return "signup_disabled";
  if (
    i.errorCode === "bad_oauth_state" ||
    (i.error === "invalid_request" && description.includes("state"))
  ) {
    return "state_mismatch";
  }
  if (i.errorCode === "otp_expired" || i.errorCode === "flow_state_expired") {
    return "link_expired";
  }
  return "unknown";
}

/** Plain-language copy for /auth/error. Anything outside the closed list gets the default. */
export function authErrorCopy(code: string): { title: string; description: string } {
  switch (code) {
    case "access_denied":
      return {
        title: "Google sign-in was canceled",
        description:
          "Google's permission screen was closed or declined. Try again whenever you're ready.",
      };
    case "state_mismatch":
      return {
        title: "Google sign-in didn't finish",
        description:
          "The attempt expired or was interrupted. Try again in a single browser tab and finish the Google steps within 10 minutes. If it keeps happening, make sure your browser allows cookies for this site.",
      };
    case "disposable_email":
      return {
        title: "Use a work email address",
        description: "Please sign up with a non-disposable email address.",
      };
    case "captcha_failed":
      return {
        title: "The security check didn't pass",
        description:
          "Reload the page and try again. If you use an ad blocker, allow challenges.cloudflare.com.",
      };
    case "signup_disabled":
      return {
        title: "Sign-ups are closed",
        description:
          "New accounts can't be created right now. If you were invited, use the link in your invitation email.",
      };
    case "link_expired":
      return {
        title: "That link has expired",
        description: "Request a new email from the sign-in page.",
      };
    default:
      return {
        title: "Sign-in didn't finish",
        description:
          "Something went wrong while signing you in. Please try again — if it keeps failing, contact support.",
      };
  }
}

type AuthErrorLike = { code?: string; message?: string; status?: number } | null;

const CAPTCHA_MESSAGE = "The security check didn't pass. Try again.";
const RATE_LIMIT_MESSAGE = "Too many attempts. Wait a minute and try again.";

function isRateLimited(err: NonNullable<AuthErrorLike>): boolean {
  return err.status === 429 || err.code === "over_request_rate_limit";
}

function mentions(err: NonNullable<AuthErrorLike>, needle: string): boolean {
  return (err.message ?? "").toLowerCase().includes(needle);
}

export function signInErrorMessage(err: AuthErrorLike): {
  kind: "invalid_credentials" | "unconfirmed" | "captcha" | "rate_limited" | "other";
  message: string;
} {
  if (err) {
    if (err.code === "invalid_credentials" || err.message === "Invalid login credentials") {
      return {
        kind: "invalid_credentials",
        message: "That email and password did not match. Check them and try again.",
      };
    }
    if (err.code === "email_not_confirmed") {
      return {
        kind: "unconfirmed",
        message: "Confirm your email first. We sent you a link when you signed up.",
      };
    }
    if (mentions(err, "captcha")) return { kind: "captcha", message: CAPTCHA_MESSAGE };
    if (isRateLimited(err)) return { kind: "rate_limited", message: RATE_LIMIT_MESSAGE };
  }
  return { kind: "other", message: "We could not sign you in. Please try again." };
}

export function signUpErrorMessage(err: AuthErrorLike): {
  kind: "disposable" | "captcha" | "exists" | "weak_password" | "rate_limited" | "other";
  message: string;
} {
  if (err) {
    if (mentions(err, "non-disposable")) {
      return {
        kind: "disposable",
        message: "Please sign up with a non-disposable email address.",
      };
    }
    if (mentions(err, "captcha")) return { kind: "captcha", message: CAPTCHA_MESSAGE };
    if (err.code === "user_already_exists") {
      return {
        kind: "exists",
        message: "An account with this email already exists. Sign in instead.",
      };
    }
    if (err.code === "weak_password") {
      return {
        kind: "weak_password",
        message: "Choose a stronger password: at least 10 characters.",
      };
    }
    if (isRateLimited(err)) return { kind: "rate_limited", message: RATE_LIMIT_MESSAGE };
  }
  return {
    kind: "other",
    message: "We could not create your account. Check the email and password and try again.",
  };
}
