// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/onboarding/PostSignupOnboarding.tsx:22-69
//   src/client/features/onboarding/OnboardingCard.tsx:8-51
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import type { ReactNode } from "react";
import { PerceevLogo } from "@/components/app/brand/PerceevLogo";
import { Button } from "@/components/ui/button";
import { ONBOARDING_STEP_LABELS, type OnboardingStep } from "@/shared/onboarding";

export function OnboardingShell({
  email,
  steps,
  current,
  saving = false,
  onStep,
  onSignOut,
  children,
  footer,
}: {
  email: string;
  steps: OnboardingStep[];
  current: OnboardingStep;
  saving?: boolean;
  onStep(step: OnboardingStep): void;
  onSignOut(): void;
  children: ReactNode;
  footer: ReactNode;
}) {
  const currentIndex = steps.indexOf(current);
  return (
    <div className="flex min-h-[100dvh] flex-col items-center bg-background px-4 pb-8">
      <header className="flex w-full max-w-5xl items-center justify-between py-5">
        <PerceevLogo size="sm" />
        <details className="relative">
          <summary className="max-w-[65vw] cursor-pointer list-none truncate rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {email || "Account"}
          </summary>
          <div className="absolute right-0 z-20 mt-1 w-48 rounded-lg border bg-popover p-2 shadow-lg">
            <p className="truncate px-2 py-1 text-xs text-muted-foreground">{email}</p>
            <Button variant="ghost" className="w-full justify-start" onClick={onSignOut}>Sign out</Button>
          </div>
        </details>
      </header>

      <main className="mt-4 w-full max-w-xl rounded-2xl border bg-card p-5 shadow-sm sm:mt-8 sm:p-8 md:mt-12 md:p-10">
        <nav aria-label="Onboarding steps" className="mb-8 flex gap-2">
          {steps.map((step, index) => (
            <button
              key={step}
              type="button"
              aria-label={`Step ${index + 1}: ${ONBOARDING_STEP_LABELS[step]}`}
              aria-current={step === current ? "step" : undefined}
              title={ONBOARDING_STEP_LABELS[step]}
              onClick={() => onStep(step)}
              className="group h-6 min-w-0 flex-1 rounded-sm p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className={`block h-1 rounded-full transition-colors ${step === current ? "bg-primary" : "bg-border group-hover:bg-muted-foreground/40"}`} />
            </button>
          ))}
        </nav>
        <fieldset disabled={saving} className="min-w-0 space-y-6 disabled:opacity-80">
          {children}
        </fieldset>
        <div className="mt-8 border-t pt-5">{footer}</div>
        {currentIndex >= 0 ? <p className="sr-only" aria-live="polite">Step {currentIndex + 1} of {steps.length}: {ONBOARDING_STEP_LABELS[current]}</p> : null}
      </main>
    </div>
  );
}
