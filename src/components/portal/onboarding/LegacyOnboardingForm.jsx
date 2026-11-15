"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Info } from "lucide-react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import AuthLayout from "@/components/portal/AuthLayout";

export default function LegacyOnboardingForm() {
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
    return (
      <AuthLayout
        eyebrow="Workspace setup"
        title="Set up your workspace"
        titleId="onboarding-title"
        subtitle="Tell us which brand to track. You can change this later."
      >
        <p className="pv-auth-loading">Loading workspace setup…</p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      eyebrow="Workspace setup"
      title="Set up your workspace"
      titleId="onboarding-title"
      subtitle="Tell us which brand to track. You can change this later."
      footer={<>Already invited to a workspace? <Link href="/portal">Open your workspace</Link>.</>}
    >
      <form onSubmit={createWorkspace}>
        <div className="pv-field">
          <label className="pv-label" htmlFor="brand-name">Company or brand name</label>
          <input className="pv-input" id="brand-name" autoComplete="organization" maxLength={120} required value={brandName} onChange={(event) => setBrandName(event.target.value)} />
          <span className="pv-hint">The brand whose visibility in AI answers you want to track.</span>
        </div>
        <div className="pv-field">
          <label className="pv-label" htmlFor="website">Website</label>
          <input className="pv-input" id="website" type="url" autoComplete="url" required value={website} onChange={(event) => setWebsite(event.target.value)} placeholder="https://example.com" />
          <span className="pv-hint">Your main site. You can connect Google Search Console later from your workspace.</span>
        </div>
        <button className="pv-btn pv-btn--primary pv-btn--block" type="submit" disabled={saving}>
          {saving ? <span className="pv-spinner" aria-hidden="true" /> : null}
          {saving ? "Creating workspace…" : "Create workspace"}
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
