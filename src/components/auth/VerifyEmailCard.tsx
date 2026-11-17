"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/routes/verify-email.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import Link from "next/link";
import React, { useEffect, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import AuthLayout from "@/components/portal/AuthLayout";
import { getSupabaseBrowserClient } from "@/shared/supabase/browser";
import {
  authCallbackUrl,
  DEFAULT_AFTER_SIGN_IN,
  normalizeAuthRedirect,
  signInHref,
} from "@/shared/auth-redirect";
import { TurnstileWidget, useTurnstileCaptcha } from "./TurnstileWidget";
import { trackAuthEvent } from "./telemetry";

export interface VerifyEmailCardProps {
  email?: string;
  next?: string;
  error?: string;
  turnstileSiteKey?: string;
}

export function VerifyEmailCard({
  email = "",
  next,
  error,
  turnstileSiteKey = "",
}: VerifyEmailCardProps) {
  const destination = normalizeAuthRedirect(next, DEFAULT_AFTER_SIGN_IN);
  const [isResending, setIsResending] = useState(false);
  const [isConfirmed, setIsConfirmed] = useState(false);

  const isTurnstileEnabled = Boolean(turnstileSiteKey);
  const captcha = useTurnstileCaptcha();

  // Check if session is already confirmed
  useEffect(() => {
    let cancelled = false;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;

    supabase.auth
      .getUser()
      .then((res: { data?: { user?: { email_confirmed_at?: string | null } | null }; error?: unknown }) => {
        if (cancelled) return;
        const user = res?.data?.user;
        if (!res?.error && user && user.email_confirmed_at) {
          setIsConfirmed(true);
          trackAuthEvent("auth:verification_success");
          window.location.replace(destination);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [destination]);

  // Telemetry for verification issues
  useEffect(() => {
    if (error) {
      trackAuthEvent("auth:verification_issue", {
        issue_type: error === "link_expired" ? "link_expired" : "unknown",
      });
    }
  }, [error]);

  async function handleResend() {
    if (!email) return;
    setIsResending(true);

    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      toast.error("We couldn't send another email right now. Please try again.");
      setIsResending(false);
      return;
    }

    const captchaToken = captcha.tokenRef.current;
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const emailRedirectTo = authCallbackUrl(origin, destination);

    try {
      const { error: resendError } = await supabase.auth.resend({
        type: "signup",
        email,
        options: {
          emailRedirectTo,
          ...(captchaToken ? { captchaToken } : {}),
        },
      });

      if (resendError) {
        if (isTurnstileEnabled) captcha.reset();
        toast.error("We couldn't send another email right now. Please try again.");
        return;
      }

      trackAuthEvent("auth:verification_resend");
      toast.success("A new email is on the way.");
      if (isTurnstileEnabled) captcha.reset();
    } catch {
      if (isTurnstileEnabled) captcha.reset();
      toast.error("We couldn't send another email right now. Please try again.");
    } finally {
      setIsResending(false);
    }
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

  if (isConfirmed) {
    return (
      <AuthLayout
        title="Email confirmed"
        titleId="verify-title"
        subtitle="You're all set. Taking you to your account now."
        footer={footerNode}
      >
        <div className="flex justify-center py-4">
          <Spinner className="size-6" />
        </div>
      </AuthLayout>
    );
  }

  if (error === "link_expired") {
    return (
      <AuthLayout
        title="We couldn't confirm your email"
        titleId="verify-title"
        footer={footerNode}
      >
        <div className="space-y-4">
          <Alert variant="destructive" role="alert">
            <AlertDescription>
              This link has expired. Request a new email to keep going.
            </AlertDescription>
          </Alert>

          {isTurnstileEnabled && email ? (
            <TurnstileWidget
              siteKey={turnstileSiteKey}
              onToken={captcha.onToken}
              resetNonce={captcha.resetNonce}
            />
          ) : null}

          {email ? (
            <Button
              type="button"
              variant="secondary"
              className="w-full font-semibold"
              onClick={handleResend}
              disabled={isResending || (isTurnstileEnabled && !captcha.hasToken)}
              pending={isResending}
            >
              {isResending ? "Sending email…" : "Resend email"}
            </Button>
          ) : null}
        </div>
      </AuthLayout>
    );
  }

  const helper = email
    ? `Click the link we sent to ${email} to verify your email.`
    : "Check your inbox for the link to verify your email.";

  return (
    <AuthLayout
      title="Verify your email"
      titleId="verify-title"
      subtitle={helper}
      footer={footerNode}
    >
      <div className="space-y-4">
        {isTurnstileEnabled && email ? (
          <TurnstileWidget
            siteKey={turnstileSiteKey}
            onToken={captcha.onToken}
            resetNonce={captcha.resetNonce}
          />
        ) : null}

        {email ? (
          <Button
            type="button"
            variant="secondary"
            className="w-full font-semibold"
            onClick={handleResend}
            disabled={isResending || (isTurnstileEnabled && !captcha.hasToken)}
            pending={isResending}
          >
            {isResending ? "Sending email…" : "Resend email"}
          </Button>
        ) : null}
      </div>
    </AuthLayout>
  );
}
