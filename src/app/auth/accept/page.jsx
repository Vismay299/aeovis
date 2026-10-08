"use client";

import Link from "next/link";
import { useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";

export default function AcceptInvitePage() {
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function savePassword(event) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const supabase = getSupabaseBrowserClient();
    const { data: { user } = {}, error: userError } = supabase ? await supabase.auth.getUser() : { data: {}, error: new Error("not configured") };
    if (userError || !user) {
      setMessage("This invitation link is no longer active. Ask your Perceev contact to send a new one.");
      setBusy(false);
      return;
    }
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setMessage("We could not save that password. Use at least 8 characters and try again.");
      setBusy(false);
      return;
    }
    window.location.assign("/portal");
  }

  return (
    <main className="customer-auth-page">
      <section className="customer-auth-card" aria-labelledby="accept-title">
        <Link href="/" className="customer-auth-brand">perceev</Link>
        <p className="customer-auth-kicker">YOUR CUSTOMER WORKSPACE</p>
        <h1 id="accept-title">Set your password.</h1>
        <p className="customer-auth-copy">Choose a password to finish setting up your Perceev account.</p>
        <form onSubmit={savePassword} className="customer-auth-form">
          <label htmlFor="password">New password</label>
          <input id="password" type="password" minLength={8} autoComplete="new-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
          <button className="btn btn--primary customer-auth-submit" type="submit" disabled={busy}>{busy ? "Saving…" : "Set password"}</button>
        </form>
        {message ? <p className="customer-auth-message" role="status">{message}</p> : null}
      </section>
    </main>
  );
}
