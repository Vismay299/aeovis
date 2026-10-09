"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";

export default function CustomerOnboardingPage() {
  const router = useRouter();
  const [brandName, setBrandName] = useState("");
  const [website, setWebsite] = useState("https://");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    async function load() {
      const supabase = getSupabaseBrowserClient();
      const { data: { user } = {} } = supabase ? await supabase.auth.getUser() : { data: {} };
      if (!live) return;
      if (!user) {
        router.replace(`/login?next=${encodeURIComponent("/onboarding")}`);
        return;
      }

      const response = await fetch("/api/customer/onboard", { cache: "no-store" });
      const result = await response.json();
      if (!live) return;
      if (response.status === 401) {
        router.replace(`/login?next=${encodeURIComponent("/onboarding")}`);
        return;
      }
      if (result.has_workspace) {
        router.replace("/portal");
        return;
      }
      setBrandName(user.user_metadata?.display_name || "");
      setWebsite(user.user_metadata?.website || "https://");
      if (!response.ok) setMessage(result.error || "Workspace setup is not available right now.");
      setBusy(false);
    }
    load().catch(() => {
      if (live) {
        setMessage("Could not load workspace setup. Refresh and try again.");
        setBusy(false);
      }
    });
    return () => { live = false; };
  }, [router]);

  async function createWorkspace(event) {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    try {
      const response = await fetch("/api/customer/onboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand_name: brandName, website }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error([result.error, result.action].filter(Boolean).join(" "));
      router.replace("/portal");
    } catch (error) {
      setMessage(error.message || "Could not create the workspace. Please retry.");
    } finally {
      setSaving(false);
    }
  }

  if (busy) {
    return <main className="customer-auth-page"><p className="customer-portal-state">Loading workspace setup…</p></main>;
  }

  return (
    <main className="customer-auth-page">
      <section className="customer-auth-card customer-onboarding-card" aria-labelledby="onboarding-title">
        <Link href="/" className="customer-auth-brand">perceev</Link>
        <p className="customer-auth-kicker">WORKSPACE SETUP</p>
        <h1 id="onboarding-title">Create your workspace.</h1>
        <p className="customer-auth-copy">Enter your brand name and website to set up an isolated workspace. You can connect Google Search Console later from your workspace.</p>
        <form onSubmit={createWorkspace} className="customer-auth-form">
          <label htmlFor="brand-name">Company or brand name</label>
          <input id="brand-name" autoComplete="organization" maxLength={120} required value={brandName} onChange={(event) => setBrandName(event.target.value)} />
          <label htmlFor="website">Website</label>
          <input id="website" type="url" autoComplete="url" required value={website} onChange={(event) => setWebsite(event.target.value)} placeholder="https://example.com" />
          <button className="btn btn--primary customer-auth-submit" type="submit" disabled={saving}>{saving ? "Creating workspace…" : "Create workspace"}</button>
        </form>
        {message ? <p className="customer-auth-message" role="status">{message}</p> : null}
        <p className="customer-auth-invite">Already invited to a workspace? <Link href="/portal">Open your workspace</Link>.</p>
      </section>
    </main>
  );
}