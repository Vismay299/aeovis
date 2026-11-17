"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/routes/_auth.sign-up.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import Link from "next/link";
import React, { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageLoading } from "@/components/app/Spinner";
import { getSupabaseBrowserClient } from "@/shared/supabase/browser";
import { signUpErrorMessage } from "@/shared/auth-errors";
import {
  authCallbackUrl,
  DEFAULT_AFTER_SIGN_IN,
  verifyEmailHref,
} from "@/shared/auth-redirect";
import { isDisposableEmailDomain } from "@/shared/disposable-email";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/shared/password";
import { AuthMethodChooser } from "./AuthMethodChooser";
import { TermsAgreementNotice } from "./TermsAgreementNotice";
import { TurnstileWidget, useTurnstileCaptcha } from "./TurnstileWidget";
import { useGoogleAuth } from "./useGoogleAuth";
import { useRedirectIfSignedIn } from "./useRedirectIfSignedIn";
import { trackAuthEvent } from "./telemetry";

export interface SignUpFormProps {
  googleEnabled?: boolean;
  turnstileSiteKey?: string;
  onboardingPath: string;
  next?: string;
}

export function SignUpForm({
  googleEnabled = false,
  turnstileSiteKey = "",
  onboardingPath,
  next,
}: SignUpFormProps) {
  const { checking } = useRedirectIfSignedIn(onboardingPath);

  const [showEmailForm, setShowEmailForm] = useState(!googleEnabled);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const [emailError, setEmailError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  const emailInputRef = useRef<HTMLInputElement>(null);

  const google = useGoogleAuth({ next: onboardingPath, intent: "sign_up" });
  const isTurnstileEnabled = Boolean(turnstileSiteKey);
  const captcha = useTurnstileCaptcha();

  useEffect(() => {
    if (showEmailForm) {
      emailInputRef.current?.focus();
    }
  }, [showEmailForm]);

  if (checking) {
    return <PageLoading />;
  }

  const loginParams = new URLSearchParams();
  if (next && next !== DEFAULT_AFTER_SIGN_IN) {
    loginParams.set("next", next);
  }
  const loginHref = loginParams.toString() ? `/login?${loginParams.toString()}` : "/login";

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault();
    setEmailError("");
    setPasswordError("");
    setErrorMessage("");

    const trimmedEmail = email.trim();

    // 1. Client-side disposable email pre-check (AC-05)
    if (isDisposableEmailDomain(trimmedEmail)) {
      setEmailError("Please sign up with a non-disposable email address.");
      trackAuthEvent("auth:signup_blocked", { reason: "disposable_email" });
      return;
    }

    // 2. Client-side password rules validation
    if (password.length < PASSWORD_MIN_LENGTH) {
      setPasswordError(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
      return;
    }
    if (password.length > PASSWORD_MAX_LENGTH) {
      setPasswordError(`Password must be at most ${PASSWORD_MAX_LENGTH} characters.`);
      return;
    }

    if (password !== confirmPassword) {
      setPasswordError("Passwords do not match.");
      return;
    }

    setBusy(true);
    trackAuthEvent("auth:sign_up_submit");

    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setErrorMessage("Customer sign-up is not configured on this deployment yet.");
      setBusy(false);
      return;
    }

    const captchaToken = captcha.tokenRef.current;
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const emailRedirectTo = authCallbackUrl(origin, onboardingPath);

    const { data, error } = await supabase.auth.signUp({
      email: trimmedEmail,
      password,
      options: {
        emailRedirectTo,
        ...(captchaToken ? { captchaToken } : {}),
      },
    });

    if (error) {
      if (isTurnstileEnabled) captcha.reset();
      const err = signUpErrorMessage(error);
      setErrorMessage(err.message);
      setBusy(false);
      return;
    }

    if (data?.session) {
      trackAuthEvent("auth:sign_up_success", { needs_verification: false });
      window.location.assign(onboardingPath);
      return;
    }

    trackAuthEvent("auth:sign_up_success", { needs_verification: true });
    window.location.assign(verifyEmailHref(trimmedEmail, onboardingPath));
  }

  if (googleEnabled && !showEmailForm) {
    return (
      <div className="space-y-4">
        <AuthMethodChooser
          googleLabel="Continue with Google"
          busy={google.isStarting}
          onGoogle={() => {
            void google.start();
          }}
          onEmail={() => {
            setShowEmailForm(true);
            google.clearError();
          }}
        />

        <TermsAgreementNotice action="By continuing" />

        {google.error ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{google.error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link href={loginHref} className="text-foreground underline underline-offset-2 hover:text-foreground/80">
            Sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSignUp} className="space-y-4">
      {errorMessage ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-1">
        <label htmlFor="email" className="sr-only">
          Work email
        </label>
        <Input
          ref={emailInputRef}
          id="email"
          type="email"
          placeholder="Email address…"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (emailError) setEmailError("");
          }}
          className="border-foreground/20 bg-card text-base md:text-base"
        />
        {emailError ? (
          <p role="alert" className="text-sm text-destructive">
            {emailError}
          </p>
        ) : null}
      </div>

      <div className="space-y-1">
        <label htmlFor="password" className="sr-only">
          Password
        </label>
        <Input
          id="password"
          type="password"
          placeholder="Password…"
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            if (passwordError) setPasswordError("");
          }}
          className="border-foreground/20 bg-card text-base md:text-base"
        />
        <span className="text-xs text-muted-foreground">At least {PASSWORD_MIN_LENGTH} characters.</span>
      </div>

      <div className="space-y-1">
        <label htmlFor="confirmPassword" className="sr-only">
          Confirm password
        </label>
        <Input
          id="confirmPassword"
          type="password"
          placeholder="Confirm password…"
          autoComplete="new-password"
          required
          value={confirmPassword}
          onChange={(e) => {
            setConfirmPassword(e.target.value);
            if (passwordError) setPasswordError("");
          }}
          className="border-foreground/20 bg-card text-base md:text-base"
        />
        {passwordError ? (
          <p role="alert" className="text-sm text-destructive">
            {passwordError}
          </p>
        ) : null}
      </div>

      {isTurnstileEnabled ? (
        <TurnstileWidget
          siteKey={turnstileSiteKey}
          onToken={captcha.onToken}
          resetNonce={captcha.resetNonce}
        />
      ) : null}

      <Button
        type="submit"
        className="w-full font-semibold"
        disabled={busy || (isTurnstileEnabled && !captcha.hasToken)}
        pending={busy}
      >
        {busy ? "Creating account…" : "Create account"}
      </Button>

      <TermsAgreementNotice action="By creating an account" />

      {googleEnabled ? (
        <div className="text-center">
          <button
            type="button"
            onClick={() => {
              setShowEmailForm(false);
              setErrorMessage("");
              setEmailError("");
              setPasswordError("");
            }}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Back to sign up
          </button>
        </div>
      ) : null}

      <div className="text-center text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link href={loginHref} className="text-foreground underline underline-offset-2 hover:text-foreground/80">
          Sign in
        </Link>
      </div>
    </form>
  );
}
