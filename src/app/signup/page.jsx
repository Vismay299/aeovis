"use client";

import Link from "next/link";
import { useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";

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
    <main className="customer-auth-page">
      <section className="customer-auth-card" aria-labelledby="signup-title">
        <Link href="/" className="customer-auth-brand">perceev</Link>
        <p className="customer-auth-kicker">CUSTOMER WORKSPACE</p>
        <h1 id="signup-title">Create your account.</h1>
        <p className="customer-auth-copy">Verify your email, then connect a Search Console property to set up your brand workspace.</p>
        <form onSubmit={signUp} className="customer-auth-form">
          <label htmlFor="email">Work email</label>
          <input id="email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
          <label htmlFor="password">Password</label>
          <input id="password" type="password" minLength={10} autoComplete="new-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
          <button className="btn btn--primary customer-auth-submit" type="submit" disabled={busy}>{busy ? "Creating account…" : "Create account"}</button>
        </form>
        {message ? <p className="customer-auth-message" role="status">{message}</p> : null}
        <p className="customer-auth-invite">Already have an account? <Link href="/login">Sign in</Link>.</p>
      </section>
    </main>
  );
}
