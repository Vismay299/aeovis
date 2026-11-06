"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/routes/forgot-password.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import Link from "next/link";
import React, { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageLoading } from "@/components/app/Spinner";
import AuthLayout from "@/components/portal/AuthLayout";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import {
  authCallbackUrl,
  DEFAULT_AFTER_SIGN_IN,
  normalizeAuthRedirect,
  signInHref,
} from "@/shared/auth-redirect";
import { TurnstileWidget, useTurnstileCaptcha } from "./TurnstileWidget";
import { useRedirectIfSignedIn } from "./useRedirectIfSignedIn";
import { trackAuthEvent } from "./telemetry";

export interface ForgotPasswordFormProps {
  initialEmail?: string;
  next?: string;
  turnstileSiteKey?: string;
}

export function ForgotPasswordForm({
  initialEmail = "",
  next,
  turnstileSiteKey = "",
}: ForgotPasswordFormProps) {
  const destination = normalizeAuthRedirect(next, DEFAULT_AFTER_SIGN_IN);
  const { checking } = useRedirectIfSignedIn(destination);

  const [email, setEmail] = useState(initialEmail);
  const [submittedEmail, setSubmittedEmail] = useState("");
  const [isSuccess, setIsSuccess] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const isTurnstileEnabled = Boolean(turnstileSiteKey);
  const captcha = useTurnstileCaptcha();

  if (checking) {
    return <PageLoading />;
  }

  const loginLink = signInHref(destination);
  const footerNode = (
    <p className="text-sm">
      <Link
        href={loginLink}
        className="text-muted-foreground transition-colors hover:text-foreground"
      >
        Back to sign in
      </Link>
    </p>
  );

  async function handleSendReset(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrorMessage("");

    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setErrorMessage("We couldn't send the reset email right now. Please try again.");
      setBusy(false);
      return;
    }

    const trimmedEmail = email.trim();
    const captchaToken = captcha.tokenRef.current;
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const redirectTo = authCallbackUrl(origin, "/auth/reset");

    try {
      const { error } = await supabase.auth.resetPasswordForEmail(trimmedEmail, {
        redirectTo,
        ...(captchaToken ? { captchaToken } : {}),
      });

      if (error) {
        if (isTurnstileEnabled) captcha.reset();
        setErrorMessage("We couldn't send the reset email right now. Please try again.");
        return;
      }

      trackAuthEvent("auth:password_reset_requested");
      setSubmittedEmail(trimmedEmail);
      setIsSuccess(true);
    } catch {
      if (isTurnstileEnabled) captcha.reset();
      setErrorMessage("We couldn't send the reset email right now. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (isSuccess) {
    return (
      <AuthLayout
        title="Check your email"
        titleId="forgot-title"
        footer={footerNode}
      >
        <div className="space-y-4">
          <Alert variant="success" role="status">
            <AlertDescription>
              If an account exists for {submittedEmail}, you'll receive password reset instructions shortly.
            </AlertDescription>
          </Alert>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Forgot password"
      titleId="forgot-title"
      subtitle="Enter your email and we'll send you a password reset link."
      footer={footerNode}
    >
      <form onSubmit={handleSendReset} className="space-y-4">
        {errorMessage ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        <div className="space-y-1">
          <label htmlFor="email" className="sr-only">
            Email address
          </label>
          <Input
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
          {busy ? "Sending reset link…" : "Send reset link"}
        </Button>
      </form>
    </AuthLayout>
  );
}
