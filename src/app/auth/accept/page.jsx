"use client";

import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { consumeCustomerAuthFragment } from "@/lib/supabase/authLink";
import AuthLayout from "@/components/portal/AuthLayout";

export default function AcceptInvitePage() {
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    consumeCustomerAuthFragment().then(() => setReady(true)).catch((error) => setMessage(error.message));
  }, []);

  async function savePassword(event) {
    event.preventDefault();
    if (!ready) return;
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
    const { error: inviteError } = await supabase.rpc("accept_customer_team_invites");
    if (inviteError) {
      setMessage("Your password was saved, but workspace access could not be assigned. Please retry.");
      setBusy(false);
      return;
    }
    window.location.assign("/portal");
  }

  return (
    <AuthLayout
      eyebrow="Your customer workspace"
      title="Set your password."
      titleId="accept-title"
      subtitle="Choose a password to finish setting up your Perceev account."
    >
      <form onSubmit={savePassword}>
        <div className="pv-field">
          <label className="pv-label" htmlFor="password">New password</label>
          <input className="pv-input" id="password" type="password" minLength={8} autoComplete="new-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
          <span className="pv-hint">At least 8 characters.</span>
        </div>
        <button className="pv-btn pv-btn--primary pv-btn--block" type="submit" disabled={busy || !ready}>
          {busy ? <span className="pv-spinner" aria-hidden="true" /> : null}
          {busy ? "Saving…" : "Set password"}
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
