"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/routes/reset-password.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import Link from "next/link";
import React, { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import AuthLayout from "@/components/portal/AuthLayout";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { consumeCustomerAuthFragment } from "@/lib/supabase/authLink";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/shared/password";

export function ResetPasswordForm() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [ready, setReady] = useState(false);
  const [fragmentError, setFragmentError] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [validationError, setValidationError] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    consumeCustomerAuthFragment()
      .then(() => setReady(true))
      .catch(() => {
        setFragmentError(true);
      });
  }, []);

  async function handleUpdatePassword(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setValidationError("");
    setErrorMessage("");

    if (password.length < PASSWORD_MIN_LENGTH) {
      setValidationError(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
      return;
    }
    if (password.length > PASSWORD_MAX_LENGTH) {
      setValidationError(`Password must be at most ${PASSWORD_MAX_LENGTH} characters.`);
      return;
    }

    if (password !== confirmPassword) {
      setValidationError("Passwords do not match.");
      return;
    }

    setBusy(true);
    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setErrorMessage("This reset link may have expired. Request a fresh one from the sign-in page.");
      setBusy(false);
      return;
    }

    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) {
        setErrorMessage("This reset link may have expired. Request a fresh one from the sign-in page.");
        setBusy(false);
        return;
      }
      setIsComplete(true);
    } catch {
      setErrorMessage("This reset link may have expired. Request a fresh one from the sign-in page.");
    } finally {
      setBusy(false);
    }
  }

  const footerNode = (
    <p className="text-sm">
      <Link
        href="/login"
        className="text-muted-foreground transition-colors hover:text-foreground"
      >
        Back to sign in
      </Link>
    </p>
  );

  if (fragmentError) {
    return (
      <AuthLayout
        title="Reset link expired"
        titleId="reset-title"
        subtitle="This reset link is no longer valid. Request a new one to keep going."
        footer={footerNode}
      >
        <div className="space-y-4">
          <Link
            href="/auth/forgot"
            className={buttonVariants({ variant: "secondary", className: "w-full font-semibold" })}
          >
            Request a new reset link
          </Link>
        </div>
      </AuthLayout>
    );
  }

  if (isComplete) {
    return (
      <AuthLayout
        title="Password updated"
        titleId="reset-title"
        subtitle="Your password has been updated. Sign in with your new password."
        footer={footerNode}
      >
        <div className="space-y-4">
          <Link
            href="/login"
            className={buttonVariants({ variant: "secondary", className: "w-full font-semibold" })}
          >
            Continue to sign in
          </Link>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Reset password"
      titleId="reset-title"
      subtitle="Choose a new password for your account."
      footer={footerNode}
    >
      <form onSubmit={handleUpdatePassword} className="space-y-4">
        {errorMessage ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        <div className="space-y-1">
          <label htmlFor="password" className="sr-only">
            New password
          </label>
          <Input
            id="password"
            type="password"
            placeholder="New password…"
            minLength={PASSWORD_MIN_LENGTH}
            maxLength={PASSWORD_MAX_LENGTH}
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (validationError) setValidationError("");
            }}
            className="border-foreground/20 bg-card text-base md:text-base"
          />
          <span className="text-xs text-muted-foreground">At least {PASSWORD_MIN_LENGTH} characters.</span>
        </div>

        <div className="space-y-1">
          <label htmlFor="confirmPassword" className="sr-only">
            Confirm new password
          </label>
          <Input
            id="confirmPassword"
            type="password"
            placeholder="Confirm new password…"
            autoComplete="new-password"
            required
            value={confirmPassword}
            onChange={(e) => {
              setConfirmPassword(e.target.value);
              if (validationError) setValidationError("");
            }}
            className="border-foreground/20 bg-card text-base md:text-base"
          />
          {validationError ? (
            <p role="alert" className="text-sm text-destructive">
              {validationError}
            </p>
          ) : null}
        </div>

        <Button
          type="submit"
          className="w-full font-semibold"
          disabled={busy || !ready}
          pending={busy}
        >
          {busy ? "Updating password…" : "Update password"}
        </Button>
      </form>
    </AuthLayout>
  );
}
