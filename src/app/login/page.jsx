"use client";

import Link from "next/link";
import { useState } from "react";
import { Info } from "lucide-react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import AuthLayout from "@/components/portal/AuthLayout";

export default function CustomerLoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function signIn(event) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setMessage("Customer login is not configured on this deployment yet.");
      setBusy(false);
      return;
    }
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (error) {
      setMessage(error.message === "Invalid login credentials"
        ? "That email and password did not match. Check them and try again."
        : "We could not sign you in. Please try again.");
      setBusy(false);
      return;
    }
    const query = new URLSearchParams(window.location.search);
    const requested = query.get("next");
    const next = requested?.startsWith("/") && !requested.startsWith("//") ? requested : "/portal";
    window.location.assign(next);
  }

  async function sendReset() {
    const supabase = getSupabaseBrowserClient();
    if (!email.trim()) {
      setMessage("Enter your email first, then choose password reset.");
      return;
    }
    if (!supabase) {
      setMessage("Customer login is not configured on this deployment yet.");
      return;
    }
    const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent("/auth/reset")}`;
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo });
    setMessage(error ? "We could not send a reset email. Check the address and try again." : "If this account exists, a password reset email is on its way.");
  }

  return (
    <AuthLayout
      eyebrow="Customer workspace"
      title="Welcome back."
      titleId="login-title"
      subtitle="Sign in to view your brand’s visibility, scans, content, and Search Console connection."
      footer={<>New to Perceev? <Link href="/signup">Create a customer account</Link>.</>}
    >
      <form onSubmit={signIn}>
        <div className="pv-field">
          <label className="pv-label" htmlFor="email">Work email</label>
          <input className="pv-input" id="email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
        </div>
        <div className="pv-field">
          <label className="pv-label" htmlFor="password">Password</label>
          <input className="pv-input" id="password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
        </div>
        <button className="pv-btn pv-btn--primary pv-btn--block" type="submit" disabled={busy}>
          {busy ? <span className="pv-spinner" aria-hidden="true" /> : null}
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <button className="pv-auth-link" type="button" onClick={sendReset}>Forgot your password?</button>
      {message ? (
        <div className="pv-banner pv-banner--info" role="status">
          <Info aria-hidden="true" />
          <div className="pv-banner__body">{message}</div>
        </div>
      ) : null}
    </AuthLayout>
  );
}
