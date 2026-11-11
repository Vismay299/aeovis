"use client";

import { useMemo } from "react";
import { z } from "zod";
import { PageHeader } from "@/components/app/PageHeader";
import { NavTabs } from "@/components/app/NavTabs";
import { Skeleton } from "@/components/ui/skeleton";
import { useUrlSearchState } from "@/components/app/hooks/useUrlSearchState";
import { cn } from "@/lib/utils";
import { BusinessPicker } from "./BusinessPicker";
import { ProfileTab } from "./ProfileTab";
import { ReviewsTab } from "./ReviewsTab";
import { PostsTab } from "./PostsTab";
import { QuestionsTab } from "./QuestionsTab";
import { useLocalBusinesses } from "./hooks/useLocalBusinesses";

export const localUrlStateSchema = z.object({
  tab: z
    .enum(["profile", "reviews", "posts", "questions", "grid", "results"])
    .default("profile"),
  business: z.string().optional(),
  fetch: z.string().optional(),
  grid: z.string().optional(),
});

export type LocalUrlState = z.infer<typeof localUrlStateSchema>;

const DEFAULT_URL_STATE: LocalUrlState = {
  tab: "profile",
  business: undefined,
  fetch: undefined,
  grid: undefined,
};

const TABS: Array<{
  id: "profile" | "reviews" | "posts" | "questions" | "grid" | "results";
  label: string;
}> = [
  { id: "profile", label: "Profile" },
  { id: "reviews", label: "Reviews" },
  { id: "posts", label: "Posts" },
  { id: "questions", label: "Questions" },
  { id: "grid", label: "Map rankings" },
  { id: "results", label: "Local results" },
];

export function LocalSeoPage({
  brandKey,
  workspaceDisplayName,
}: {
  brandKey: string;
  workspaceDisplayName?: string;
}) {
  const [urlState, setUrlState] = useUrlSearchState(
    localUrlStateSchema,
    DEFAULT_URL_STATE
  );

  const {
    businesses,
    ownBusiness,
    competitors,
    isLoading,
    isError,
    saveBusiness,
    removeBusiness,
    refreshProfile,
    isRefreshingProfile,
  } = useLocalBusinesses(brandKey);

  const selectedBusiness = useMemo(() => {
    if (!urlState.business) return ownBusiness;
    return (
      competitors.find((c) => c.id === urlState.business) ??
      (ownBusiness?.id === urlState.business ? ownBusiness : ownBusiness)
    );
  }, [urlState.business, competitors, ownBusiness]);

  const activeTab = urlState.tab;

  return (
    <div className="space-y-6" data-slot="local-seo-page">
      <PageHeader
        title="Local SEO"
        description="See how your business looks and ranks on Google Maps: profile, reviews, posts, questions and map rankings around your location."
      />

      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-28 w-full rounded-lg" />
          <Skeleton className="h-64 w-full rounded-lg" />
        </div>
      ) : isError ? (
        <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive">
          Couldn't load your saved businesses.
        </div>
      ) : (
        <>
          <BusinessPicker
            brandKey={brandKey}
            defaultBusinessName={workspaceDisplayName}
            ownBusiness={ownBusiness}
            competitors={competitors}
            selectedBusinessId={urlState.business ?? null}
            onSelectBusinessId={(id) =>
              setUrlState({ business: id ?? undefined })
            }
            onSaveBusiness={saveBusiness}
            onRemoveCompetitor={removeBusiness}
            onRefreshProfile={refreshProfile}
            isRefreshingProfile={isRefreshingProfile}
          />

          {ownBusiness && (
            <div className="space-y-6">
              <NavTabs label="Local SEO sections">
                {TABS.map((t) => {
                  const isActive = activeTab === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setUrlState({ tab: t.id })}
                      data-status={isActive ? "active" : undefined}
                      aria-current={isActive ? "page" : undefined}
                      className={cn(
                        "relative inline-flex h-9 items-center px-3 text-sm font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:rounded-md focus-visible:ring-3 focus-visible:ring-ring/50 data-[status=active]:text-foreground",
                        "after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-foreground after:opacity-0 data-[status=active]:after:opacity-100"
                      )}
                    >
                      {t.label}
                    </button>
                  );
                })}
              </NavTabs>

              {selectedBusiness && (
                <div data-slot="tab-content">
                  {activeTab === "profile" && (
                    <ProfileTab
                      brandKey={brandKey}
                      business={selectedBusiness}
                      ownBusiness={ownBusiness}
                      competitors={competitors}
                      onRefreshProfile={refreshProfile}
                      isRefreshingProfile={isRefreshingProfile}
                    />
                  )}

                  {activeTab === "reviews" && (
                    <ReviewsTab
                      brandKey={brandKey}
                      business={selectedBusiness}
                      currentFetchId={urlState.fetch ?? null}
                      onSelectFetchId={(id) =>
                        setUrlState({ fetch: id ?? undefined })
                      }
                    />
                  )}

                  {activeTab === "posts" && (
                    <PostsTab
                      brandKey={brandKey}
                      business={selectedBusiness}
                      currentFetchId={urlState.fetch ?? null}
                      onSelectFetchId={(id) =>
                        setUrlState({ fetch: id ?? undefined })
                      }
                    />
                  )}

                  {activeTab === "questions" && (
                    <QuestionsTab
                      brandKey={brandKey}
                      business={selectedBusiness}
                      currentFetchId={urlState.fetch ?? null}
                      onSelectFetchId={(id) =>
                        setUrlState({ fetch: id ?? undefined })
                      }
                    />
                  )}

                  {activeTab === "grid" && (
                    <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
                      Map rankings grid will be available in Phase 4.
                    </div>
                  )}

                  {activeTab === "results" && (
                    <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
                      Local search results will be available in Phase 4.
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
