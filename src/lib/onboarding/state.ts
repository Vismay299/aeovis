import type { SupabaseClient } from "@supabase/supabase-js";
import { isFeatureEnabled as defaultIsFeatureEnabled } from "../features/flags.ts";
import type { FeatureName } from "../features/names.ts";
import {
  type OnboardingStep,
  type StepStatus,
  visibleSteps,
} from "../../shared/onboarding.ts";
import {
  readFreeScanPrefill as defaultReadFreeScanPrefill,
  type Prefill,
} from "./freeScanHandoff.ts";
import { completeOnboarding as defaultCompleteOnboarding } from "./steps.ts";
import { readQuestionSettings as defaultReadQuestionSettings } from "../questions/workspaceQuestions.ts";
import { getQuestionsState as defaultGetQuestionsState } from "../questions/state.ts";
import { getGa4ConnectionState as defaultGetGa4ConnectionState } from "../ga4/connection.ts";

export type OnboardingState = {
  enabled: boolean;
  needsOnboarding: boolean;
  completedAt: string | null;
  workspace: {
    brandKey: string;
    displayName: string;
    website: string;
    websiteHost: string;
    role: "owner" | "member";
    telemetryId: string;
    hasScans: boolean;
  } | null;
  visibleSteps: OnboardingStep[];
  steps: Partial<Record<OnboardingStep, StepStatus>>;
  market: { country: string; language: string } | null;
  prefill: Prefill | null;
  handoff: {
    domain: string | null;
    scanId: string | null;
    importedQuestions?: number;
    importedAt?: string | null;
  } | null;
  audit: {
    available: boolean;
    auditId: string | null;
    status: string;
    pagesCrawled: number;
    pagesTotal: number;
  } | null;
  research: {
    available: boolean;
    status: string;
    jobId: string | null;
  } | null;
  questions: {
    curation: boolean;
    approvedVersion: number | null;
    active: number;
    paused: number;
  } | null;
  gsc: {
    connected: boolean;
    property: string | null;
  } | null;
  ga4: {
    available: boolean;
    connected: boolean;
  } | null;
  preferences: {
    productUpdatesAvailable: boolean;
    analyticsAvailable: boolean;
  } | null;
  domainOverview: boolean;
  pollAfterSeconds: number | null;
};

export type OnboardingStateDeps = {
  isFeatureEnabled?: (name: FeatureName, brandKey?: string) => Promise<boolean>;
  readFreeScanPrefill?: typeof defaultReadFreeScanPrefill;
  completeOnboarding?: typeof defaultCompleteOnboarding;
  readQuestionSettings?: typeof defaultReadQuestionSettings;
  getQuestionsState?: typeof defaultGetQuestionsState;
  getGa4ConnectionState?: typeof defaultGetGa4ConnectionState;
};

export function needsOnboarding(i: {
  flagEnabled: boolean;
  completedAt: string | null;
  hasRow: boolean;
  hasWorkspace: boolean;
  workspaceHasScans: boolean;
}): boolean {
  if (!i.flagEnabled) return false;
  if (i.completedAt) return false;
  if (!i.hasRow) {
    return !i.hasWorkspace;
  }
  if (i.workspaceHasScans) return false;
  return true;
}

export async function getOnboardingState(
  admin: SupabaseClient,
  user: { id: string; email?: string | null },
  query: { scanId?: string | null; domain?: string | null } = {},
  deps?: OnboardingStateDeps,
): Promise<OnboardingState> {
  const isFlagOn = deps?.isFeatureEnabled ?? defaultIsFeatureEnabled;
  const enabled = await isFlagOn("onboarding_wizard");

  if (!enabled) {
    return {
      enabled: false,
      needsOnboarding: false,
      completedAt: null,
      workspace: null,
      visibleSteps: [],
      steps: {},
      market: null,
      prefill: null,
      handoff: null,
      audit: null,
      research: null,
      questions: null,
      gsc: null,
      ga4: null,
      preferences: null,
      domainOverview: false,
      pollAfterSeconds: null,
    };
  }

  // 1. Read user_onboarding row
  const { data: row } = await admin
    .from("user_onboarding")
    .select("user_id, brand_key, completed_at, completed_via, steps, handoff")
    .eq("user_id", user.id)
    .maybeSingle();

  // 2. Read memberships for user
  const { data: memberships } = await admin
    .from("customer_brand_memberships")
    .select("brand_key, role")
    .eq("user_id", user.id);

  const userMemberships = memberships ?? [];
  const hasWorkspace = userMemberships.length > 0;

  // Determine active brandKey for onboarding
  const brandKey = row?.brand_key ?? null;

  let workspaceData: OnboardingState["workspace"] = null;
  let workspaceHasScans = false;

  if (brandKey) {
    const { data: brand } = await admin
      .from("customer_brands")
      .select("brand_key, display_name, website, website_host, telemetry_id")
      .eq("brand_key", brandKey)
      .maybeSingle();

    if (brand) {
      // Check scans count
      const { count: scansCount } = await admin
        .from("scans")
        .select("id", { count: "exact", head: true })
        .eq("brand_key", brandKey);

      workspaceHasScans = (scansCount ?? 0) > 0;

      const mem = userMemberships.find((m) => m.brand_key === brandKey);
      const role = (mem?.role as "owner" | "member") ?? "owner";

      workspaceData = {
        brandKey: brand.brand_key,
        displayName: brand.display_name,
        website: brand.website,
        websiteHost: brand.website_host,
        role,
        telemetryId: brand.telemetry_id,
        hasScans: workspaceHasScans,
      };
    }
  }

  // Auto-complete if row is incomplete but workspace has scans
  let completedAt = row?.completed_at ? String(row.completed_at) : null;
  if (!completedAt && row && workspaceHasScans) {
    const completeFn = deps?.completeOnboarding ?? defaultCompleteOnboarding;
    const completed = await completeFn(admin, user.id, "first_scan");
    completedAt = completed.completedAt;
  }

  const needs = needsOnboarding({
    flagEnabled: enabled,
    completedAt,
    hasRow: Boolean(row),
    hasWorkspace,
    workspaceHasScans,
  });

  // Prefill from free scan
  const prefillFn = deps?.readFreeScanPrefill ?? defaultReadFreeScanPrefill;
  const prefill = await prefillFn(admin, query.scanId, query.domain);

  // Check workspace features if workspace exists
  const [
    ga4Flag,
    emailFlag,
    analyticsFlag,
    siteAuditFlag,
    questionSetupFlag,
    questionCurationFlag,
    domainOverviewFlag,
  ] = await Promise.all([
    isFlagOn("ga4", brandKey ?? undefined),
    isFlagOn("lifecycle_email", brandKey ?? undefined),
    isFlagOn("product_analytics", brandKey ?? undefined),
    isFlagOn("site_audit", brandKey ?? undefined),
    isFlagOn("question_setup", brandKey ?? undefined),
    isFlagOn("question_curation", brandKey ?? undefined),
    isFlagOn("domain_research", brandKey ?? undefined),
  ]);

  let ga4Configured = false;
  let ga4Connected = false;
  if (brandKey) {
    try {
      const ga4Fn = deps?.getGa4ConnectionState ?? defaultGetGa4ConnectionState;
      const ga4State = await ga4Fn(admin, { brandKey });
      ga4Configured = Boolean(ga4State?.configured);
      ga4Connected = Boolean(ga4State?.connected);
    } catch {
      ga4Configured = false;
      ga4Connected = false;
    }
  }

  const ga4Available = Boolean(ga4Flag && ga4Configured);
  const preferencesAvailable = Boolean(emailFlag || analyticsFlag);

  const visible = visibleSteps({
    ga4Available,
    preferencesAvailable,
  });

  // Steps map
  const rawSteps = (row?.steps as Record<string, { status: StepStatus }> | null) ?? {};
  const steps: Partial<Record<OnboardingStep, StepStatus>> = {};
  for (const s of visible) {
    steps[s] = rawSteps[s]?.status ?? "todo";
  }

  // Market
  let market: { country: string; language: string } | null = null;
  if (brandKey) {
    try {
      const readSettings = deps?.readQuestionSettings ?? defaultReadQuestionSettings;
      const settings = await readSettings(admin, brandKey);
      market = {
        country: settings.country ?? "in",
        language: settings.language ?? "en",
      };
    } catch {
      market = { country: "in", language: "en" };
    }
  }

  // Audit state
  let auditState: OnboardingState["audit"] = null;
  if (!siteAuditFlag) {
    auditState = {
      available: false,
      auditId: null,
      status: "unavailable",
      pagesCrawled: 0,
      pagesTotal: 0,
    };
  } else if (brandKey) {
    const { data: auditRow } = await admin
      .from("site_audits")
      .select("id, status, pages_crawled, max_pages")
      .eq("brand_key", brandKey)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (auditRow) {
      auditState = {
        available: true,
        auditId: auditRow.id,
        status: auditRow.status,
        pagesCrawled: auditRow.pages_crawled ?? 0,
        pagesTotal: auditRow.max_pages ?? 50,
      };
    } else {
      auditState = {
        available: true,
        auditId: null,
        status: "not_started",
        pagesCrawled: 0,
        pagesTotal: 50,
      };
    }
  } else {
    auditState = {
      available: true,
      auditId: null,
      status: "not_started",
      pagesCrawled: 0,
      pagesTotal: 50,
    };
  }

  // Research / Questions
  let researchState: OnboardingState["research"] = null;
  let questionsState: OnboardingState["questions"] = null;

  if (brandKey) {
    try {
      const getQState = deps?.getQuestionsState ?? defaultGetQuestionsState;
      const qState = await getQState(admin, { brandKey } as any);

      if (!questionSetupFlag) {
        researchState = {
          available: false,
          status: "unavailable",
          jobId: null,
        };
      } else {
        researchState = {
          available: true,
          status: qState.setup?.status ?? "none",
          jobId: qState.setup?.jobId ?? null,
        };
      }

      const activeCount = qState.questions?.filter((q) => q.status === "active").length ?? 0;
      const pausedCount = qState.questions?.filter((q) => q.status === "paused").length ?? 0;

      questionsState = {
        curation: questionCurationFlag !== false,
        approvedVersion: qState.approved?.version ?? null,
        active: activeCount,
        paused: pausedCount,
      };
    } catch {
      researchState = {
        available: questionSetupFlag,
        status: questionSetupFlag ? "none" : "unavailable",
        jobId: null,
      };
      questionsState = {
        curation: questionCurationFlag !== false,
        approvedVersion: null,
        active: 0,
        paused: 0,
      };
    }
  }

  // GSC
  let gscState: OnboardingState["gsc"] = null;
  if (brandKey) {
    const { data: gscConn } = await admin
      .from("gsc_connections")
      .select("enabled, property_id, site_url")
      .eq("brand_key", brandKey)
      .maybeSingle();

    gscState = {
      connected: Boolean(gscConn?.enabled),
      property: gscConn?.property_id ?? gscConn?.site_url ?? null,
    };
  } else {
    gscState = {
      connected: false,
      property: null,
    };
  }

  // Polling
  const isAuditRunning =
    auditState?.status === "running" || auditState?.status === "queued";
  const isResearchRunning = researchState?.status === "running";
  const pollAfterSeconds = isAuditRunning || isResearchRunning ? 5 : null;

  return {
    enabled,
    needsOnboarding: needs,
    completedAt,
    workspace: workspaceData,
    visibleSteps: visible,
    steps,
    market,
    prefill,
    handoff: (row?.handoff as OnboardingState["handoff"]) ?? null,
    audit: auditState,
    research: researchState,
    questions: questionsState,
    gsc: gscState,
    ga4: {
      available: ga4Available,
      connected: ga4Connected,
    },
    preferences: {
      productUpdatesAvailable: emailFlag,
      analyticsAvailable: analyticsFlag,
    },
    domainOverview: domainOverviewFlag,
    pollAfterSeconds,
  };
}
