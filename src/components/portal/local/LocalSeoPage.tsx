"use client";

import { useMemo } from "react";
import { z } from "zod";
import { PageHeader } from "@/components/app/PageHeader";
import { NavTabButton, NavTabs } from "@/components/app/NavTabs";
import { Skeleton } from "@/components/ui/skeleton";
import { useUrlSearchState } from "@/components/app/hooks/useUrlSearchState";
import { BusinessPicker } from "./BusinessPicker";
import { ProfileTab } from "./ProfileTab";
import { ReviewsTab } from "./ReviewsTab";
import { PostsTab } from "./PostsTab";
import { QuestionsTab } from "./QuestionsTab";
import { GridTab } from "./GridTab";
import { LocalResultsTab } from "./LocalResultsTab";
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
              // A fetch belongs to one business: keep it and the new
              // business would show the previous business's collection.
              setUrlState({ business: id ?? undefined, fetch: undefined })
            }
            onSaveBusiness={saveBusiness}
            onRemoveCompetitor={removeBusiness}
            onRefreshProfile={refreshProfile}
            isRefreshingProfile={isRefreshingProfile}
          />

          {ownBusiness && (
            <div className="space-y-6">
              <NavTabs label="Local SEO sections">
                {TABS.map((t) => (
                  <NavTabButton
                    key={t.id}
                    active={activeTab === t.id}
                    onClick={() => setUrlState({ tab: t.id, fetch: t.id === activeTab ? urlState.fetch : undefined })}
                  >
                    {t.label}
                  </NavTabButton>
                ))}
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
                    <GridTab
                      brandKey={brandKey}
                      business={selectedBusiness}
                      currentGridId={urlState.grid ?? null}
                      onSelectGridId={(id) =>
                        setUrlState({ grid: id ?? undefined })
                      }
                    />
                  )}

                  {activeTab === "results" && (
                    <LocalResultsTab
                      brandKey={brandKey}
                      business={selectedBusiness}
                      competitors={competitors}
                      onSaveBusiness={saveBusiness}
                    />
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
