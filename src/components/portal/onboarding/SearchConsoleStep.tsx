// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/onboarding/SearchConsoleOnboardingStep.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import PropertyPicker from "@/components/portal/gsc/PropertyPicker";
import { fetchJson } from "@/shared/query/fetchJson";
import { trackOnboardingEvent } from "./telemetry";
import type { OnboardingState } from "./hooks/useOnboardingState";

export function SearchConsoleStep({
  state,
  params,
  onBack,
  onSkipStep,
  onStepDone,
  onNext,
  onParams,
}: {
  state: OnboardingState;
  params: URLSearchParams;
  onBack(): void;
  onSkipStep(): Promise<void>;
  onStepDone(): Promise<void>;
  onNext(): void;
  onParams(next: URLSearchParams): void;
}) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const workspace = state.workspace;
  const attemptId = params.get("gsc_attempt");
  const gscError = params.get("gsc_error");
  const owner = workspace?.role === "owner";

  async function connect() {
    if (!workspace || !owner) return;
    setOpening(true);
    setError("");
    trackOnboardingEvent("onboarding:gsc_connect_clicked", {});
    try {
      const result = await fetchJson<{ authorization_url: string }>("/api/customer/gsc/connect", {
        method: "POST",
        body: { brand_key: workspace.brandKey, return_to: "/onboarding" },
      });
      window.location.assign(result.authorization_url);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not connect Google Search Console.");
    } finally {
      setOpening(false);
    }
  }

  async function connected(property?: { siteUrl?: string }) {
    trackOnboardingEvent("onboarding:gsc_property_selected", {});
    await onStepDone();
    onNext();
  }

  function clearReturn() {
    const next = new URLSearchParams(params);
    next.delete("gsc_attempt");
    next.delete("gsc_connected");
    next.delete("gsc_error");
    onParams(next);
  }

  if (!workspace) {
    return <div className="space-y-6"><p className="text-sm text-muted-foreground">Add your website first.</p><Button variant="ghost" onClick={onBack}>Back</Button></div>;
  }

  const footer = (
    <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
      <Button variant="ghost" onClick={onBack}>Back</Button>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
        <Button variant="ghost" onClick={() => void onSkipStep()}>Skip for now</Button>
        <Button onClick={() => { void onStepDone().then(onNext); }} disabled={Boolean(owner && !state.gsc?.connected)}>
          Continue
        </Button>
      </div>
    </div>
  );

  if (!owner) {
    return <div className="space-y-6"><p className="text-sm text-muted-foreground">Only workspace owners can connect Google Search Console.</p>{footer}</div>;
  }

  if (attemptId) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Connect Google Search Console</h1>
        <PropertyPicker
          brandKey={workspace.brandKey}
          attemptId={attemptId}
          website={workspace.website}
          onConnected={connected}
          onCancel={clearReturn}
          onRestart={() => void connect()}
          redirectToLogin={() => window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`)}
        />
        {footer}
      </div>
    );
  }

  if (state.gsc?.connected) {
    return <div className="space-y-6"><div className="space-y-2"><h1 className="text-2xl font-semibold tracking-tight">Connect Google Search Console</h1><p className="text-sm text-muted-foreground">Connected to {state.gsc.property || workspace.website}.</p></div>{footer}</div>;
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2"><h1 className="text-2xl font-semibold tracking-tight">Connect Google Search Console</h1><p className="text-sm text-muted-foreground">See which Google searches bring people to your site.</p></div>
      {gscError ? <Alert variant="destructive"><AlertDescription>{gscError} <Button variant="link" className="h-auto p-0" onClick={() => { clearReturn(); void connect(); }}>Try again</Button></AlertDescription></Alert> : null}
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      <Button variant="outline" onClick={() => void connect()} pending={opening}>Connect with Google</Button>
      {opening ? <span className="text-sm text-muted-foreground" role="status">Opening Google…</span> : null}
      {footer}
    </div>
  );
}
