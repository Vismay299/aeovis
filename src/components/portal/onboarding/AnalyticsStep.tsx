"use client";

import { Button } from "@/components/ui/button";
import { Ga4ConnectionCard } from "@/components/portal/settings/integrations/Ga4ConnectionCard";
import { trackOnboardingEvent } from "./telemetry";
import type { OnboardingState } from "./hooks/useOnboardingState";

export function AnalyticsStep({ state, onBack, onSkipStep, onStepDone, onNext }: {
  state: OnboardingState;
  onBack(): void;
  onSkipStep(): Promise<void>;
  onStepDone(): Promise<void>;
  onNext(): void;
}) {
  if (!state.ga4?.available || !state.workspace) return null;
  const footer = (
    <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
      <Button variant="ghost" onClick={onBack}>Back</Button>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
        <Button variant="ghost" onClick={() => void onSkipStep()}>Skip for now</Button>
        <Button onClick={() => { void onStepDone().then(onNext); }} disabled={!state.ga4.connected}>Continue</Button>
      </div>
    </div>
  );
  return (
    <div className="space-y-6">
      <div className="space-y-2"><h1 className="text-2xl font-semibold tracking-tight">Connect Google Analytics</h1><p className="text-sm text-muted-foreground">Optional. See which pages bring engaged visitors and where AI-driven traffic lands.</p></div>
      <Ga4ConnectionCard brandKey={state.workspace.brandKey} returnTo="/onboarding" onConnectClick={() => trackOnboardingEvent("onboarding:ga4_connect_clicked", {})} />
      {footer}
    </div>
  );
}
