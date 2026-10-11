"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { consumeCustomerAuthFragment } from "@/lib/supabase/authLink";
import AuthLayout from "@/components/portal/AuthLayout";

export default function ResetPasswordPage() {
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    consumeCustomerAuthFragment().then(() => setReady(true)).catch((error) => setMessage(error.message));
  }, []);

  async function updatePassword(event) {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    const supabase = getSupabaseBrowserClient();
    const { error } = supabase ? await supabase.auth.updateUser({ password }) : { error: new Error("not configured") };
    setMessage(error ? "This reset link may have expired. Request a fresh one from the sign-in page." : "Password updated. You can sign in with it now.");
    setBusy(false);
  }

  return (
    <AuthLayout
      eyebrow="Account security"
      title="Choose a new password."
      titleId="reset-title"
    >
      <form onSubmit={updatePassword}>
        <div className="pv-field">
          <label className="pv-label" htmlFor="password">New password</label>
          <input className="pv-input" id="password" type="password" minLength={8} autoComplete="new-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
          <span className="pv-hint">At least 8 characters.</span>
        </div>
        <button className="pv-btn pv-btn--primary pv-btn--block" type="submit" disabled={busy || !ready}>
          {busy ? <span className="pv-spinner" aria-hidden="true" /> : null}
          {busy ? "Saving…" : "Update password"}
        </button>
      </form>
      {message ? (
        <div className="pv-banner pv-banner--info" role="status">
          <Info aria-hidden="true" />
          <div className="pv-banner__body">
            {message} <Link href="/login">Go to sign in</Link>
          </div>
        </div>
      ) : null}
    </AuthLayout>
  );
}
