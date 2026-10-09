"use client";

import Link from "next/link";
import { useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";

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
    <main className="customer-auth-page">
      <section className="customer-auth-card" aria-labelledby="login-title">
        <Link href="/" className="customer-auth-brand">perceev</Link>
        <p className="customer-auth-kicker">CUSTOMER WORKSPACE</p>
        <h1 id="login-title">Welcome back.</h1>
        <p className="customer-auth-copy">Sign in to view your brand’s visibility, scans, content, and Search Console connection.</p>
        <form onSubmit={signIn} className="customer-auth-form">
          <label htmlFor="email">Work email</label>
          <input id="email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
          <label htmlFor="password">Password</label>
          <input id="password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
          <button className="btn btn--primary customer-auth-submit" type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        </form>
        <button className="customer-auth-link" type="button" onClick={sendReset}>Forgot your password?</button>
        {message ? <p className="customer-auth-message" role="status">{message}</p> : null}
        <p className="customer-auth-invite">New to Perceev? <Link href="/signup">Create a customer account</Link>.</p>
      </section>
    </main>
  );
}
