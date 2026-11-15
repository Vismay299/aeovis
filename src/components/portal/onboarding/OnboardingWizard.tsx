// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/routes/_authenticated.onboarding.index.tsx:18-151
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AppProviders } from "@/components/app/providers/AppProviders";
import { StatusScreen } from "@/components/app/StatusScreen";
import { Button } from "@/components/ui/button";
import { PortalContext } from "@/components/portal/PortalShell";
import LegacyOnboardingForm from "./LegacyOnboardingForm";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { setTelemetryIdentity, resetTelemetry } from "@/lib/telemetry/client";
import { describeError } from "@/lib/query/errors";
import { fetchJson } from "@/lib/query/fetchJson";
import { onboardingKeys } from "@/lib/query/keys";
import { finishDestination, nextStep, onboardingHref, previousStep, resolveStep, type OnboardingStep } from "@/shared/onboarding";
import { OnboardingShell } from "./OnboardingShell";
import { WebsiteStep } from "./WebsiteStep";
import { SearchConsoleStep } from "./SearchConsoleStep";
import { AnalyticsStep } from "./AnalyticsStep";
import { PreferencesStep } from "./PreferencesStep";
import { FirstScanStep } from "./FirstScanStep";
import { useOnboardingState } from "./hooks/useOnboardingState";
import type { OnboardingState } from "./hooks/useOnboardingState";
import { trackOnboardingEvent } from "./telemetry";

type SignedInUser = { id: string; email: string; user_metadata?: Record<string, unknown> };

export default function OnboardingWizard() {
  return <AppProviders><OnboardingWizardPage /></AppProviders>;
}

function OnboardingWizardPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [authStatus, setAuthStatus] = useState<"checking" | "ready" | "error">("checking");
  const [user, setUser] = useState<SignedInUser | null>(null);
  const [params, setParams] = useState<URLSearchParams | null>(null);
  const [step, setStep] = useState<OnboardingStep | null>(null);
  const completionStarted = useRef(false);
  const scan = params?.get("scan") || null;
  const domain = params?.get("domain") || null;
  const redirect = params?.get("redirect") || null;
  const query = useOnboardingState({ scan, domain, enabled: authStatus === "ready" && params !== null });
  const state = query.data;

  useEffect(() => {
    const initial = new URLSearchParams(window.location.search);
    setParams(initial);
    const onPopState = () => setParams(new URLSearchParams(window.location.search));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    let live = true;
    async function checkUser() {
      const supabase = getSupabaseBrowserClient();
      if (!supabase) {
        if (live) setAuthStatus("error");
        return;
      }
      const { data: { user: signedIn } = {}, error } = await supabase.auth.getUser();
      if (!live) return;
      if (error || !signedIn) {
        window.location.replace(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
        return;
      }
      if (!signedIn.email_confirmed_at) {
        window.location.replace(`/auth/verify?email=${encodeURIComponent(signedIn.email || "")}&next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
        return;
      }
      const account = { id: signedIn.id, email: signedIn.email || "", user_metadata: signedIn.user_metadata };
      setUser(account);
      setTelemetryIdentity({ userId: account.id, workspaceTelemetryId: null });
      setAuthStatus("ready");
    }
    checkUser().catch(() => { if (live) setAuthStatus("error"); });
    return () => { live = false; };
  }, []);

  const updateParams = useCallback((next: URLSearchParams) => {
    setParams(next);
    const suffix = next.toString();
    router.replace(`/onboarding${suffix ? `?${suffix}` : ""}`, { scroll: false });
  }, [router]);

  const visibleSteps = state?.visibleSteps || [];

  const goToStep = useCallback((next: OnboardingStep) => {
    if (!visibleSteps.includes(next)) return;
    setStep(next);
    const href = onboardingHref(next, { domain, scan, redirect });
    updateParams(new URL(href, "http://127.0.0.1").searchParams);
  }, [visibleSteps, updateParams, domain, scan, redirect]);

  useEffect(() => {
    if (!state || !params || step) return;
    const initial = resolveStep(params.get("step"), {
      visible: state.visibleSteps,
      statuses: state.steps,
      hasGa4Return: params.has("ga4") || params.has("ga4_error"),
    });
    setStep(initial);
    if (params.get("step") !== initial) {
      const next = new URLSearchParams(params);
      next.set("step", initial);
      updateParams(next);
    }
  }, [state, params, step, updateParams]);

  const lastViewedStep = useRef<OnboardingStep | null>(null);
  useEffect(() => {
    if (!state || !step || lastViewedStep.current === step) return;
    const index = state.visibleSteps.indexOf(step);
    if (index >= 0) {
      lastViewedStep.current = step;
      trackOnboardingEvent("onboarding:step_viewed", { step: index + 1, step_name: step });
    }
  }, [state, step]);

  const recordStep = useCallback(async (status: "done" | "skipped", forStep: OnboardingStep = step || "website") => {
    await fetchJson("/api/customer/onboarding/step", { method: "POST", body: { step: forStep, status } });
    await query.refetch();
  }, [step, query]);

  const complete = useCallback(async (via: "wizard" | "first_scan" | "skipped"): Promise<string> => {
    const result = await fetchJson<{ destination: string }>("/api/customer/onboarding/complete", { method: "POST", body: { via } });
    if (via === "skipped") return "/portal";
    return finishDestination({
      redirect,
      handoffDomain: state?.handoff?.domain || domain,
      handoffScan: state?.handoff?.scanId || scan,
      workspaceHost: state?.workspace?.websiteHost || null,
      domainOverviewOn: state?.domainOverview === true,
    }) || result.destination || "/portal";
  }, [redirect, state, domain, scan]);

  const skipStep = useCallback(async () => {
    if (!step) return;
    const index = state?.visibleSteps.indexOf(step) ?? -1;
    trackOnboardingEvent("onboarding:step_skipped", { step: index + 1, step_name: step });
    await recordStep("skipped", step);
    const following = state ? nextStep(step, state.visibleSteps) : null;
    if (following) goToStep(following);
    else window.location.assign(await complete("wizard"));
  }, [step, state, recordStep, goToStep, complete]);

  const back = useCallback(() => {
    if (!step || !state) return;
    const previous = previousStep(step, state.visibleSteps);
    if (previous) goToStep(previous);
  }, [step, state, goToStep]);

  useEffect(() => {
    if (!state || !state.workspace || (!state.completedAt && state.needsOnboarding)) return;
    const safe = finishDestination({ redirect, handoffDomain: null, handoffScan: null, workspaceHost: null, domainOverviewOn: false });
    window.location.replace(safe || "/portal");
  }, [state?.completedAt, state?.needsOnboarding, state?.workspace, redirect]);

  useEffect(() => {
    if (!state?.needsOnboarding || !state.workspace?.hasScans || completionStarted.current) return;
    completionStarted.current = true;
    void complete("first_scan").then((destination) => window.location.replace(destination)).catch(() => {
      toast.error("Setup is unavailable right now. Please retry.");
    });
  }, [state?.needsOnboarding, state?.workspace?.hasScans, complete]);

  async function signOut() {
    resetTelemetry();
    await getSupabaseBrowserClient()?.auth.signOut();
    window.location.replace("/login");
  }

  if (authStatus === "checking" || !params || query.isPending) {
    return <StatusScreen logo pending title="Setting up your workspace" description="Loading your onboarding steps…" />;
  }
  if (authStatus === "error") {
    return <StatusScreen logo title="Setup is unavailable right now. Please retry." description="Authentication is not configured on this deployment."><Button onClick={() => window.location.reload()}>Retry</Button></StatusScreen>;
  }
  if (query.error) {
    return <StatusScreen logo title="Setup is unavailable right now. Please retry." description={describeError(query.error, "Setup is unavailable right now. Please retry.")}><Button onClick={() => void query.refetch()}>Retry</Button></StatusScreen>;
  }
  if (state?.enabled === false) return <LegacyOnboardingForm />;
  if (!state || !step || !user) return <StatusScreen logo pending title="Setting up your workspace" description="Loading your onboarding steps…" />;
  if (state.workspace && (!state.needsOnboarding || state.completedAt)) return <StatusScreen logo pending title="Your workspace is ready" description="Taking you to your workspace…" />;

  const workspace = state.workspace;
  const portalBrand = workspace ? {
    brandKey: workspace.brandKey,
    role: workspace.role,
    display_name: workspace.displayName,
    website: workspace.website,
    is_active: true,
  } : null;
  const portalValue = {
    user: { id: user.id, email: user.email },
    brands: portalBrand ? [portalBrand] : [],
    brand: portalBrand,
    brandKey: workspace?.brandKey || "",
    setBrandKey: () => {},
    isOwner: workspace?.role === "owner",
    overview: null,
    overviewLoading: false,
    overviewError: "",
    refreshOverview: async () => {},
    gsc: null,
    refreshGsc: async () => {},
    scan: {} as any,
    features: {},
    redirectToLogin: () => window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`),
    signOut,
  };

  let content;
  if (step === "website") {
    content = <WebsiteStep state={state} domain={domain} onBack={undefined} onStepDone={() => recordStep("done", "website")} onSkipStep={() => skipStep()} onState={(next) => queryClient.setQueryData(onboardingKeys.state(scan, domain), next)} onComplete={complete} onNext={() => goToStep("search_console")} />;
  } else if (step === "search_console") {
    content = <SearchConsoleStep state={state} params={params} onBack={back} onSkipStep={skipStep} onStepDone={() => recordStep("done", step)} onNext={() => { const next = nextStep(step, state.visibleSteps); if (next) goToStep(next); }} onParams={updateParams} />;
  } else if (step === "analytics") {
    content = <AnalyticsStep state={state} onBack={back} onSkipStep={skipStep} onStepDone={() => recordStep("done", step)} onNext={() => { const next = nextStep(step, state.visibleSteps); if (next) goToStep(next); }} />;
  } else if (step === "preferences") {
    content = <PreferencesStep state={state} onBack={back} onSkipStep={skipStep} onStepDone={() => recordStep("done", step)} onNext={() => { const next = nextStep(step, state.visibleSteps); if (next) goToStep(next); }} />;
  } else {
    content = <FirstScanStep state={state} onBack={back} onSkipStep={skipStep} onComplete={complete} onRefresh={() => query.refetch()} />;
  }

  return (
    <PortalContext.Provider value={portalValue as any}>
      <OnboardingShell
        email={user.email}
        steps={state.visibleSteps}
        current={step}
        onStep={goToStep}
        onSignOut={() => void signOut()}
        footer={null}
      >
        {content}
      </OnboardingShell>
    </PortalContext.Provider>
  );
}
