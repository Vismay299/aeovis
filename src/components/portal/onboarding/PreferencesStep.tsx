// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/onboarding/AnalyticsOnboardingStep.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { AnalyticsConsentSwitch } from "@/components/app/telemetry/AnalyticsConsentSwitch";
import { useAnalyticsConsent } from "@/components/app/telemetry/useAnalyticsConsent";
import { ProductUpdatesSwitch } from "@/components/portal/email/ProductUpdatesSwitch";
import { useEmailPreferences } from "@/components/portal/email/hooks/useEmailPreferences";
import { trackOnboardingEvent } from "./telemetry";
import type { OnboardingState } from "./hooks/useOnboardingState";

export function PreferencesStep({ state, onBack, onSkipStep, onStepDone, onNext }: {
  state: OnboardingState;
  onBack(): void;
  onSkipStep(): Promise<void>;
  onStepDone(): Promise<void>;
  onNext(): void;
}) {
  const prefs = state.preferences;
  const analyticsConsent = useAnalyticsConsent();
  const emailPrefs = useEmailPreferences();
  const [analytics, setAnalytics] = useState(false);
  const [productUpdates, setProductUpdates] = useState(false);
  const [emailInitial, setEmailInitial] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (emailPrefs.preferences && emailInitial === null) {
      setEmailInitial(emailPrefs.preferences.productUpdates);
      setProductUpdates(emailPrefs.preferences.productUpdates);
    }
  }, [emailPrefs.preferences, emailInitial]);

  async function saveAndContinue() {
    setSaving(true);
    const writes: Promise<unknown>[] = [];
    writes.push(analyticsConsent.save(analytics, "onboarding"));
    const changedProductUpdates = emailInitial !== null && emailInitial !== productUpdates;
    if (changedProductUpdates) writes.push(emailPrefs.save("productUpdates", productUpdates, "onboarding"));
    const results = await Promise.allSettled(writes);
    if (results.some((result) => result.status === "rejected")) {
      toast.error("We couldn't save your choices. You can change them in Settings.");
      setSaving(false);
      return;
    }
    trackOnboardingEvent("onboarding:preferences_saved", { product_updates: productUpdates });
    try {
      await onStepDone();
      onNext();
    } catch {
      toast.error("We couldn't save your choices. You can change them in Settings.");
    } finally {
      setSaving(false);
    }
  }

  if (!prefs || (!prefs.analyticsAvailable && !prefs.productUpdatesAvailable)) return null;
  return (
    <div className="space-y-6">
      <div className="space-y-2"><h1 className="text-2xl font-semibold tracking-tight">Help make Perceev better</h1><p className="text-sm text-muted-foreground">You can change these any time in Settings. See our <Link className="underline underline-offset-2" href="/privacy">Privacy Policy</Link>.</p></div>
      <div className="divide-y rounded-lg border px-4">
        {prefs.analyticsAvailable ? <div className="py-4"><AnalyticsConsentSwitch source="onboarding" value={analytics} onChange={setAnalytics} disabled={saving} /></div> : null}
        {prefs.productUpdatesAvailable ? <div className="py-4"><ProductUpdatesSwitch source="onboarding" value={productUpdates} onChange={setProductUpdates} disabled={saving || emailPrefs.loading} /></div> : null}
      </div>
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Button variant="ghost" onClick={onBack}>Back</Button>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
          <Button variant="ghost" onClick={() => void onSkipStep()}>Skip for now</Button>
          <Button onClick={() => void saveAndContinue()} pending={saving} disabled={emailPrefs.loading}>Continue</Button>
        </div>
      </div>
    </div>
  );
}
