"use client";

import Link from "next/link";
import { useState } from "react";
import { Info } from "lucide-react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import AuthLayout from "@/components/portal/AuthLayout";

export default function CustomerSignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function signUp(event) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setMessage("Customer sign-up is not configured on this deployment yet.");
      setBusy(false);
      return;
    }

    const emailRedirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent("/onboarding")}`;
    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: { emailRedirectTo },
    });
    if (error) {
      setMessage("We could not create your account. Check the email and password and try again.");
      setBusy(false);
      return;
    }
    if (data.session) {
      window.location.assign("/onboarding");
      return;
    }
    setMessage("Check your inbox and verify your email. The link will take you to workspace setup.");
    setBusy(false);
  }

  return (
    <AuthLayout
      eyebrow="Customer workspace"
      title="Create your account."
      titleId="signup-title"
      subtitle="Verify your email, then connect a Search Console property to set up your brand workspace."
      footer={<>Already have an account? <Link href="/login">Sign in</Link>.</>}
    >
      <form onSubmit={signUp}>
        <div className="pv-field">
          <label className="pv-label" htmlFor="email">Work email</label>
          <input className="pv-input" id="email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
        </div>
        <div className="pv-field">
          <label className="pv-label" htmlFor="password">Password</label>
          <input className="pv-input" id="password" type="password" minLength={10} autoComplete="new-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
          <span className="pv-hint">At least 10 characters.</span>
        </div>
        <button className="pv-btn pv-btn--primary pv-btn--block" type="submit" disabled={busy}>
          {busy ? <span className="pv-spinner" aria-hidden="true" /> : null}
          {busy ? "Creating account…" : "Create account"}
        </button>
      </form>
      {message ? (
        <div className="pv-banner pv-banner--info" role="status">
          <Info aria-hidden="true" />
          <div className="pv-banner__body">{message}</div>
        </div>
      ) : null}
    </AuthLayout>
  );
}
