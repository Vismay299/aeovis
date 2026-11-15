// Portions ported from upstream (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/onboarding/onboardingModel.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import {
  normalizeAuthRedirect,
  normalizeHandoffDomain,
  normalizeScanId,
} from "./auth-redirect.ts";
import { buildDomainResearchHref } from "./domain.ts";

export const ONBOARDING_STEPS = [
  "website",
  "search_console",
  "analytics",
  "preferences",
  "first_scan",
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const ONBOARDING_STEP_LABELS: Record<OnboardingStep, string> = {
  website: "Website",
  search_console: "Google Search Console",
  analytics: "Google Analytics",
  preferences: "Preferences",
  first_scan: "Questions and first scan",
};

export type StepStatus = "todo" | "done" | "skipped";

export function visibleSteps(f: {
  ga4Available: boolean;
  preferencesAvailable: boolean;
}): OnboardingStep[] {
  const steps: OnboardingStep[] = ["website", "search_console"];
  if (f.ga4Available) {
    steps.push("analytics");
  }
  if (f.preferencesAvailable) {
    steps.push("preferences");
  }
  steps.push("first_scan");
  return steps;
}

export function resolveStep(
  param: string | null,
  i: {
    visible: OnboardingStep[];
    statuses: Partial<Record<OnboardingStep, StepStatus>>;
    hasGa4Return: boolean;
  },
): OnboardingStep {
  if (param && i.visible.includes(param as OnboardingStep)) {
    return param as OnboardingStep;
  }
  if (i.hasGa4Return && i.visible.includes("analytics")) {
    return "analytics";
  }
  const firstNotDone = i.visible.find((step) => i.statuses[step] !== "done");
  return firstNotDone ?? "first_scan";
}

export function nextStep(
  current: OnboardingStep,
  visible: OnboardingStep[],
): OnboardingStep | null {
  const idx = visible.indexOf(current);
  if (idx < 0 || idx >= visible.length - 1) return null;
  return visible[idx + 1];
}

export function previousStep(
  current: OnboardingStep,
  visible: OnboardingStep[],
): OnboardingStep | null {
  const idx = visible.indexOf(current);
  if (idx <= 0) return null;
  return visible[idx - 1];
}

export function onboardingHref(
  step: OnboardingStep,
  keep: {
    domain?: string | null;
    scan?: string | null;
    redirect?: string | null;
  },
): string {
  const params = new URLSearchParams();
  params.set("step", step);
  if (keep.domain) {
    const domain = normalizeHandoffDomain(keep.domain);
    if (domain) params.set("domain", domain);
  }
  if (keep.scan) {
    const scan = normalizeScanId(keep.scan);
    if (scan) params.set("scan", scan);
  }
  if (keep.redirect) {
    const redirect = normalizeAuthRedirect(keep.redirect, "");
    if (redirect && redirect !== "/portal") params.set("redirect", redirect);
  }
  return `/onboarding?${params.toString()}`;
}

export function finishDestination(i: {
  redirect: string | null;
  handoffDomain: string | null;
  handoffScan: string | null;
  workspaceHost: string | null;
  domainOverviewOn: boolean;
}): string {
  if (i.redirect) {
    const safeRedirect = normalizeAuthRedirect(i.redirect, "");
    if (safeRedirect) {
      return safeRedirect;
    }
  }
  if (i.handoffDomain && !i.handoffScan && i.domainOverviewOn && i.workspaceHost) {
    return buildDomainResearchHref({
      domain: i.workspaceHost,
      preset: "striking_distance",
    });
  }
  return "/portal";
}
