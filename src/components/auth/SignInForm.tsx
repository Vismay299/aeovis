"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/routes/_auth.sign-in.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import Link from "next/link";
import React, { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageLoading } from "@/components/app/Spinner";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { signInErrorMessage } from "@/shared/auth-errors";
import {
  DEFAULT_AFTER_SIGN_IN,
  normalizeAuthRedirect,
  verifyEmailHref,
} from "@/shared/auth-redirect";
import { AuthMethodChooser } from "./AuthMethodChooser";
import { TermsAgreementNotice } from "./TermsAgreementNotice";
import { TurnstileWidget, useTurnstileCaptcha } from "./TurnstileWidget";
import { useGoogleAuth } from "./useGoogleAuth";
import { useRedirectIfSignedIn } from "./useRedirectIfSignedIn";
import { trackAuthEvent } from "./telemetry";

export interface SignInFormProps {
  googleEnabled?: boolean;
  turnstileSiteKey?: string;
  next?: string;
  initialError?: string;
}

export function SignInForm({
  googleEnabled = false,
  turnstileSiteKey = "",
  next,
  initialError,
}: SignInFormProps) {
  const destination = normalizeAuthRedirect(next, DEFAULT_AFTER_SIGN_IN);
  const { checking } = useRedirectIfSignedIn(destination);

  const [showEmailForm, setShowEmailForm] = useState(!googleEnabled);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const emailInputRef = useRef<HTMLInputElement>(null);

  const google = useGoogleAuth({ next: destination, intent: "sign_in" });
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

  const signupParams = new URLSearchParams();
  if (destination && destination !== DEFAULT_AFTER_SIGN_IN) {
    signupParams.set("next", destination);
  }
  const signupHref = signupParams.toString() ? `/signup?${signupParams.toString()}` : "/signup";

  const forgotParams = new URLSearchParams();
  if (email.trim()) {
    forgotParams.set("email", email.trim());
  }
  if (destination && destination !== DEFAULT_AFTER_SIGN_IN) {
    forgotParams.set("next", destination);
  }
  const forgotHref = forgotParams.toString()
    ? `/auth/forgot?${forgotParams.toString()}`
    : "/auth/forgot";

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrorMessage("");
    trackAuthEvent("auth:sign_in_submit", { method: "email" });

    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setErrorMessage("Customer login is not configured on this deployment yet.");
      setBusy(false);
      return;
    }

    const trimmedEmail = email.trim();
    const captchaToken = captcha.tokenRef.current;
    const { error } = await supabase.auth.signInWithPassword({
      email: trimmedEmail,
      password,
      options: captchaToken ? { captchaToken } : undefined,
    });

    if (error) {
      if (isTurnstileEnabled) captcha.reset();
      const err = signInErrorMessage(error);
      if (err.kind === "unconfirmed") {
        trackAuthEvent("auth:sign_in_block_unverified");
        window.location.assign(verifyEmailHref(trimmedEmail, destination));
        return;
      }
      setErrorMessage(err.message);
      setBusy(false);
      return;
    }

    trackAuthEvent("auth:sign_in_success", { method: "email" });
    window.location.assign(destination);
  }

  if (googleEnabled && !showEmailForm) {
    return (
      <div className="space-y-4">
        {initialError === "link_expired" ? (
          <Alert variant="info" role="status">
            <AlertDescription>
              That link has expired or was already used. Sign in, or request a new link.
            </AlertDescription>
          </Alert>
        ) : null}

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

        <TermsAgreementNotice action="By continuing with Google" />

        {google.error ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{google.error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="text-center text-sm text-muted-foreground">
          <Link href={signupHref} className="text-foreground underline underline-offset-2 hover:text-foreground/80">
            Create account
          </Link>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSignIn} className="space-y-4">
      {initialError === "link_expired" && !errorMessage ? (
        <Alert variant="info" role="status">
          <AlertDescription>
            That link has expired or was already used. Sign in, or request a new link.
          </AlertDescription>
        </Alert>
      ) : null}

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
          onChange={(e) => setEmail(e.target.value)}
          className="border-foreground/20 bg-card text-base md:text-base"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="password" className="sr-only">
          Password
        </label>
        <Input
          id="password"
          type="password"
          placeholder="Password…"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="border-foreground/20 bg-card text-base md:text-base"
        />
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
        {busy ? "Signing in…" : "Sign in"}
      </Button>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <Link
          href={forgotHref}
          className="text-foreground underline underline-offset-2 hover:text-foreground/80"
        >
          Forgot password?
        </Link>
        <Link
          href={signupHref}
          className="text-foreground underline underline-offset-2 hover:text-foreground/80"
        >
          Create account
        </Link>
      </div>

      {googleEnabled ? (
        <div className="text-center">
          <button
            type="button"
            onClick={() => {
              setShowEmailForm(false);
              setErrorMessage("");
            }}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Back
          </button>
        </div>
      ) : null}
    </form>
  );
}
