"use client";

import Link from "next/link";
import { useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";

export default function ResetPasswordPage() {
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function updatePassword(event) {
    event.preventDefault();
    setBusy(true);
    const supabase = getSupabaseBrowserClient();
    const { error } = supabase ? await supabase.auth.updateUser({ password }) : { error: new Error("not configured") };
    setMessage(error ? "This reset link may have expired. Request a fresh one from the sign-in page." : "Password updated. You can sign in with it now.");
    setBusy(false);
  }

  return (
    <main className="customer-auth-page">
      <section className="customer-auth-card" aria-labelledby="reset-title">
        <Link href="/" className="customer-auth-brand">perceev</Link>
        <p className="customer-auth-kicker">ACCOUNT SECURITY</p>
        <h1 id="reset-title">Choose a new password.</h1>
        <form onSubmit={updatePassword} className="customer-auth-form">
          <label htmlFor="password">New password</label>
          <input id="password" type="password" minLength={8} autoComplete="new-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
          <button className="btn btn--primary customer-auth-submit" type="submit" disabled={busy}>{busy ? "Saving…" : "Update password"}</button>
        </form>
        {message ? <p className="customer-auth-message" role="status">{message} <Link href="/login">Go to sign in</Link></p> : null}
      </section>
    </main>
  );
}
