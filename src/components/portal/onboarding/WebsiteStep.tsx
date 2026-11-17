// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/onboarding/WebsiteOnboardingStep.tsx:28-211
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useRef, useState } from "react";
import { ChevronDown, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { usePriceQuote } from "@/components/app/cost/usePriceQuote";
import { CostReviewDialog } from "@/components/app/cost/CostReviewDialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { fetchJson, isApiError } from "@/shared/query/fetchJson";
import { describeError } from "@/shared/query/errors";
import { trackOnboardingEvent } from "./telemetry";
import type { OnboardingState } from "./hooks/useOnboardingState";

const SUPPORTED_COUNTRIES = ["in", "us", "uk", "sg", "ae", "ca", "au"] as const;

const COUNTRY_LABELS: Record<(typeof SUPPORTED_COUNTRIES)[number], string> = {
  in: "India",
  us: "United States",
  uk: "United Kingdom",
  sg: "Singapore",
  ae: "United Arab Emirates",
  ca: "Canada",
  au: "Australia",
};

function initialWebsite(state: OnboardingState, domain: string | null): string {
  return state.prefill?.website || state.workspace?.website || (domain ? `https://${domain}` : "");
}

function brandFromWebsite(website: string): string {
  try {
    const host = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname;
    const first = host.replace(/^www\./i, "").split(".")[0] || "";
    return first ? first[0].toUpperCase() + first.slice(1) : "";
  } catch {
    return "";
  }
}

export function WebsiteStep({
  state,
  domain,
  onBack,
  onStepDone,
  onSkipStep,
  onState,
  onComplete,
  onNext,
}: {
  state: OnboardingState;
  domain: string | null;
  onBack?: () => void;
  onStepDone(): Promise<void>;
  onSkipStep(): Promise<void>;
  onState(next: OnboardingState): void;
  onComplete(via: "skipped"): Promise<string>;
  onNext(): void;
}) {
  const idempotencyKey = useRef<string>(typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
  const [website, setWebsite] = useState(() => initialWebsite(state, domain));
  const [brandName, setBrandName] = useState(() => state.prefill?.brandName || state.workspace?.displayName || brandFromWebsite(initialWebsite(state, domain)));
  const [country, setCountry] = useState(state.market?.country || "in");
  const [language, setLanguage] = useState(state.market?.language || "en");
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ website?: string; brandName?: string }>({});
  const [conflict, setConflict] = useState("");
  const [researchOpen, setResearchOpen] = useState(false);
  const [researchPending, setResearchPending] = useState(false);
  const [researchError, setResearchError] = useState<string | null>(null);
  const [priceChanged, setPriceChanged] = useState<{ approvedMaxUsd: number; quote: any } | null>(null);
  const brandKey = state.workspace?.brandKey || "";
  const quote = usePriceQuote({ brandKey, action: "questions.setup.run", input: {} }, { enabled: researchOpen && Boolean(brandKey) });

  async function saveWebsite(event?: React.FormEvent) {
    event?.preventDefault();
    if (!website.trim()) {
      setFieldErrors({ website: "Enter a valid website, like acme.com." });
      return;
    }
    if (!brandName.trim()) {
      setFieldErrors({ brandName: "Enter your company or brand name." });
      return;
    }
    setSaving(true);
    setFieldErrors({});
    setConflict("");
    try {
      const nextState = await fetchJson<OnboardingState>("/api/customer/onboarding/website", {
        method: "POST",
        body: {
          website: website.trim(),
          brandName: brandName.trim(),
          country,
          language: language.trim().toLowerCase() || "en",
          handoff: { domain: state.handoff?.domain || domain, scanId: state.handoff?.scanId || null },
          idempotencyKey: idempotencyKey.current,
        },
      });
      onState(nextState);
      const researchStatus = nextState.research?.status || "none";
      const researchResult = researchStatus === "unavailable" ? "unavailable" : ["running", "review", "saved"].includes(researchStatus) ? "skipped" : "started";
      trackOnboardingEvent("onboarding:website_saved", {
        created_workspace: !state.workspace,
        country,
        research: researchResult,
      });
      if (researchResult === "started") {
        setResearchOpen(true);
      } else {
        await onStepDone();
        onNext();
      }
    } catch (error) {
      const code = isApiError(error) ? error.code : "unknown";
      trackOnboardingEvent("onboarding:website_save_failed", { error_code: code.slice(0, 64) || "unknown" });
      if (code === "website_invalid") setFieldErrors({ website: error instanceof Error ? error.message : "Enter a valid website, like acme.com." });
      else if (code === "brand_name_invalid") setFieldErrors({ brandName: error instanceof Error ? error.message : "Enter your company or brand name." });
      else if (["website_locked", "already_has_workspace", "workspace_exists"].includes(code)) setConflict(error instanceof Error ? error.message : "Workspace setup could not be saved.");
      else toast.error(describeError(error, "Could not save your website. Please retry."));
    } finally {
      setSaving(false);
    }
  }

  async function skipResearch() {
    setResearchOpen(false);
    setResearchError(null);
    await onStepDone();
    onNext();
  }

  async function startResearch(maxUsd: number) {
    if (!brandKey || !quote.data || quote.data.blocked) return;
    setResearchPending(true);
    setResearchError(null);
    try {
      await fetchJson("/api/customer/questions/setup", {
        method: "POST",
        body: { brand_key: brandKey, maxUsd },
      });
      setResearchOpen(false);
      await onStepDone();
      onNext();
    } catch (error) {
      if (isApiError(error) && ["setup_running", "job_already_running"].includes(error.code)) {
        setResearchOpen(false);
        await onStepDone();
        onNext();
        return;
      }
      if (isApiError(error) && error.code === "price_changed") {
        const replacement = error.details?.quote;
        if (replacement && typeof replacement === "object") {
          setPriceChanged({ approvedMaxUsd: maxUsd, quote: replacement });
        }
      }
      setResearchError(describeError(error, "Could not start research. Please retry."));
    } finally {
      setResearchPending(false);
    }
  }

  async function skipWebsite() {
    if (state.workspace) {
      await onSkipStep();
      return;
    }
    await onComplete("skipped");
    window.location.assign("/portal");
  }

  const blockedQuote = quote.data?.blocked;
  return (
    <>
      <form className="space-y-6" onSubmit={saveWebsite}>
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">What's your website?</h1>
          <p className="text-sm text-muted-foreground">We'll create your workspace, start a free site audit and get your buyer questions ready.</p>
        </div>
        {conflict ? <Alert variant="destructive"><AlertDescription>{conflict}</AlertDescription></Alert> : null}
        {state.prefill?.questionCount ? (
          <Alert variant="info"><AlertDescription>We'll bring the {state.prefill.questionCount} questions from your free scan into your workspace as suggestions. Nothing is tracked until you approve it.</AlertDescription></Alert>
        ) : null}
        <div className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="onboarding-website" className="text-sm font-medium">Website</label>
            <Input id="onboarding-website" autoComplete="url" placeholder="acme.com" value={website} aria-invalid={Boolean(fieldErrors.website)} onChange={(event) => setWebsite(event.target.value)} />
            {fieldErrors.website ? <p role="alert" className="text-sm text-destructive">{fieldErrors.website}</p> : null}
          </div>
          <div className="space-y-2">
            <label htmlFor="onboarding-brand" className="text-sm font-medium">Company or brand name</label>
            <Input id="onboarding-brand" autoComplete="organization" placeholder="Acme" value={brandName} aria-invalid={Boolean(fieldErrors.brandName)} onChange={(event) => setBrandName(event.target.value)} />
            <p className="text-xs text-muted-foreground">The brand AI assistants should name.</p>
            {fieldErrors.brandName ? <p role="alert" className="text-sm text-destructive">{fieldErrors.brandName}</p> : null}
          </div>
        </div>
        <Collapsible>
          <CollapsibleTrigger className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
            <ChevronDown className="size-4" aria-hidden="true" />Choose country &amp; language
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="onboarding-country">Country</label>
              <Select value={country} onValueChange={(value) => value && setCountry(value)}>
                <SelectTrigger id="onboarding-country" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{SUPPORTED_COUNTRIES.map((item) => <SelectItem key={item} value={item}>{COUNTRY_LABELS[item]}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label htmlFor="onboarding-language" className="text-sm font-medium">Language</label>
              <Input id="onboarding-language" value={language} onChange={(event) => setLanguage(event.target.value)} placeholder="en" />
              <p className="text-xs text-muted-foreground">Language code, e.g. en</p>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </form>
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Button variant="ghost" onClick={onBack} disabled={!onBack}>Back</Button>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
          <Button variant="ghost" onClick={skipWebsite} disabled={saving}>Skip for now</Button>
          <Button onClick={() => void saveWebsite()} disabled={saving || !website.trim()} pending={saving}>
            Save and continue
          </Button>
        </div>
      </div>

      {blockedQuote ? (
        <Dialog open={researchOpen} onOpenChange={(open) => !open && void skipResearch()}>
          <DialogContent showCloseButton={false}>
            <DialogHeader><DialogTitle>Research your questions</DialogTitle></DialogHeader>
            <Alert variant="destructive"><AlertDescription>{blockedQuote.message}</AlertDescription></Alert>
            <Button variant="ghost" onClick={() => void skipResearch()}>Skip research</Button>
          </DialogContent>
        </Dialog>
      ) : (
        <CostReviewDialog
          open={researchOpen}
          title="Research your questions"
          confirmLabel="Start research"
          pendingLabel="Starting…"
          quote={quote}
          pending={researchPending}
          priceChanged={priceChanged}
          error={researchError}
          detail={() => <Button variant="ghost" onClick={() => void skipResearch()}>Skip research</Button>}
          onConfirm={(maxUsd) => void startResearch(maxUsd)}
          onClose={() => setResearchOpen(false)}
        />
      )}
      {quote.isPending && researchOpen ? <span className="sr-only" role="status"><LoaderCircle className="animate-spin" />Loading research price</span> : null}
    </>
  );
}
