"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "@/shared/supabase/browser";
import { consumeCustomerAuthFragment } from "@/shared/supabase/authLink";
import AuthLayout from "@/components/portal/AuthLayout";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

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
      <form onSubmit={savePassword} className="space-y-4">
        <Field>
          <FieldLabel htmlFor="password">New password</FieldLabel>
          <Input id="password" type="password" minLength={8} autoComplete="new-password" required value={password} onChange={(event) => setPassword(event.target.value)} className="border-foreground/20 bg-card text-base md:text-base" />
          <span className="text-xs text-muted-foreground">At least 8 characters.</span>
        </Field>
        <Button className="w-full font-semibold" type="submit" pending={busy} disabled={busy || !ready}>
          {busy ? "Saving…" : "Set password"}
        </Button>
      </form>
      {message ? (
        <Alert variant="info" role="status">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}
    </AuthLayout>
  );
}
