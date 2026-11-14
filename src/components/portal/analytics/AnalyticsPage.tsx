"use client";

import Link from "next/link";
import { Suspense, useEffect } from "react";
import { PageHeader } from "@/components/app/PageHeader";
import { NotFound } from "@/components/app/NotFound";
import { SkeletonPage } from "@/components/app/SkeletonPresets";
import { EmptyState } from "@/components/app/EmptyState";
import { DataTableTabs } from "@/components/app/table/DataTableToolbar";
import { TabsTrigger } from "@/components/ui/tabs";
import { usePortal } from "@/components/portal/PortalShell";
import { useUrlSearchState } from "@/components/app/hooks/useUrlSearchState";
import { Ga4ConnectionCard } from "@/components/portal/settings/integrations/Ga4ConnectionCard";
import { useGa4Connection } from "@/components/portal/settings/integrations/hooks/useGa4Connection";
import { AnalyticsToolbar, type Ga4Range } from "./AnalyticsToolbar";
import { OrganicOverviewCard } from "./OrganicOverviewCard";
import { OpportunitiesTab } from "./OpportunitiesTab";
import { LandingPagesTab } from "./LandingPagesTab";
import { PagesTab } from "./PagesTab";
import { KeyEventsTab } from "./KeyEventsTab";
import { AcquisitionTab } from "./AcquisitionTab";
import { EcommerceTab } from "./EcommerceTab";
import { SiteSearchTab } from "./SiteSearchTab";
import { AudienceTab } from "./AudienceTab";
import { SetupHealthTab } from "./SetupHealthTab";
import { useGa4Overview } from "./hooks/useGa4Overview";
import { trackGa4Event } from "./telemetry";

const TABS = [
  { value: "opportunities", label: "Opportunities" },
  { value: "landing_pages", label: "Landing pages" },
  { value: "pages", label: "Pages" },
  { value: "key_events", label: "Key events" },
  { value: "acquisition", label: "Acquisition" },
  { value: "ecommerce", label: "E-commerce" },
  { value: "site_search", label: "Site search" },
  { value: "audience", label: "Audience" },
  { value: "setup_health", label: "Setup health" },
] as const;

type AnalyticsTab = (typeof TABS)[number]["value"];
type AnalyticsSearch = { tab: AnalyticsTab; range: Ga4Range };

const ANALYTICS_DEFAULTS: AnalyticsSearch = {
  tab: "opportunities",
  range: "last_28_days",
};

/** `?tab=` names the active tab; `?range=` the range preset; both fall back. */
const analyticsSearchSchema = {
  safeParse(value: unknown) {
    const candidate =
      typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : {};
    const tab =
      typeof candidate.tab === "string" &&
      (TABS as readonly { value: string }[]).some(
        (entry) => entry.value === candidate.tab,
      )
        ? (candidate.tab as AnalyticsTab)
        : ("opportunities" as AnalyticsTab);
    const range: Ga4Range =
      candidate.range === "last_7_days" ||
      candidate.range === "last_28_days" ||
      candidate.range === "last_90_days"
        ? candidate.range
        : "last_28_days";
    return { success: true as const, data: { tab, range } };
  },
};

function numericPropertyId(propertyId: string): string {
  return propertyId.replace(/^properties\//, "");
}

/** /portal/analytics (§6.6.3): overview plus the nine report tabs. */
export function AnalyticsPage() {
  const { brandKey, features, isOwner } = usePortal();
  const [search, setSearch] = useUrlSearchState(
    analyticsSearchSchema,
    ANALYTICS_DEFAULTS,
  );

  const connection = useGa4Connection(brandKey);
  const overview = useGa4Overview(brandKey, search.range);

  useEffect(() => {
    trackGa4Event("ga4:tab_view", { tab: search.tab });
  }, [search.tab]);

  if (features === null || connection.isPending) return <SkeletonPage />;
  if (!brandKey) {
    return (
      <EmptyState
        title="Workspace required"
        description="Select a workspace to see Analytics."
      />
    );
  }
  if (features?.ga4 !== true) return <NotFound />;

  const state = connection.data;
  const connected = state?.connected === true;
  const property = state?.property ?? null;

  if (!connected || !property) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Analytics"
          description="Organic search traffic and conversions from Google Analytics 4, joined with Search Console."
        />
        <div className="max-w-2xl">
          <Ga4ConnectionCard brandKey={brandKey} returnTo="/portal/analytics" />
        </div>
      </div>
    );
  }

  const overviewData = overview.data as unknown as
    | {
        warnings?: string[];
        dataAsOf?: string;
        request?: { currencyCode?: string };
      }
    | undefined;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Analytics"
        description="Organic search traffic and conversions from Google Analytics 4, joined with Search Console."
        actions={
          <>
            <span className="text-sm text-muted-foreground">
              {property.displayName} · {numericPropertyId(property.id)}
            </span>
            {state.canManage ? (
              <Link
                href="/portal/settings/integrations#google-analytics"
                className="text-sm text-primary underline-offset-4 hover:underline"
              >
                Change property
              </Link>
            ) : null}
          </>
        }
      />

      <AnalyticsToolbar
        range={search.range}
        onRangeChange={(range) => {
          trackGa4Event("ga4:range_change", { range });
          setSearch({ range });
        }}
        dataAsOf={overviewData?.dataAsOf ?? null}
        warnings={overviewData?.warnings ?? []}
      />

      <OrganicOverviewCard
        data={overview.data as Record<string, unknown> | undefined}
        isLoading={overview.isPending}
        isFetching={overview.isFetching}
        error={overview.error}
        canManage={state.canManage}
        onRetry={() => void overview.refetch()}
      />

      <div className="rounded-lg border border-border bg-card">
        <DataTableTabs
          value={search.tab}
          onValueChange={(value) => {
            if ((TABS as readonly { value: string }[]).some((entry) => entry.value === value)) {
              setSearch({ tab: value as AnalyticsTab });
            }
          }}
        >
          {TABS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
        </DataTableTabs>

        {search.tab === "opportunities" ? (
          <OpportunitiesTab
            brandKey={brandKey}
            range={search.range}
            canManage={state.canManage}
          />
        ) : null}
        {search.tab === "landing_pages" ? (
          <LandingPagesTab
            brandKey={brandKey}
            range={search.range}
            canManage={state.canManage}
          />
        ) : null}
        {search.tab === "pages" ? (
          <PagesTab
            brandKey={brandKey}
            range={search.range}
            canManage={state.canManage}
          />
        ) : null}
        {search.tab === "key_events" ? (
          <KeyEventsTab
            brandKey={brandKey}
            range={search.range}
            canManage={state.canManage}
          />
        ) : null}
        {search.tab === "acquisition" ? (
          <AcquisitionTab
            brandKey={brandKey}
            range={search.range}
            canManage={state.canManage}
          />
        ) : null}
        {search.tab === "ecommerce" ? (
          <EcommerceTab
            brandKey={brandKey}
            range={search.range}
            canManage={state.canManage}
          />
        ) : null}
        {search.tab === "site_search" ? (
          <SiteSearchTab
            brandKey={brandKey}
            range={search.range}
            canManage={state.canManage}
          />
        ) : null}
        {search.tab === "audience" ? (
          <AudienceTab
            brandKey={brandKey}
            range={search.range}
            canManage={state.canManage}
          />
        ) : null}
        {search.tab === "setup_health" ? (
          <SetupHealthTab brandKey={brandKey} canManage={state.canManage} />
        ) : null}
      </div>
      <p className="sr-only">
        {isOwner ? "Signed in as a workspace owner." : "Signed in as a member."}
      </p>
    </div>
  );
}

export default function AnalyticsPageWithSuspense() {
  return (
    <Suspense fallback={<SkeletonPage />}>
      <AnalyticsPage />
    </Suspense>
  );
}
