"use client";

import { useMemo, useState } from "react";
import { CardShell } from "@/components/app/CardShell";
import { EmptyState } from "@/components/app/EmptyState";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { TablePagination } from "@/components/app/table/TablePagination";
import { PricedActionButton } from "@/components/app/cost/PricedActionButton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { MessageSquareQuote, AlertCircle } from "lucide-react";
import { ReviewCard, type ReviewItem } from "./ReviewCard";
import type { SavedBusinessView } from "./hooks/useLocalBusinesses";
import { useLocalFetch, type StartFetchInput } from "./hooks/useLocalFetch";

export type ReviewsTabProps = {
  brandKey: string;
  business: SavedBusinessView;
  currentFetchId: string | null;
  onSelectFetchId: (id: string | null) => void;
};

export function ReviewsTab({
  brandKey,
  business,
  currentFetchId,
  onSelectFetchId,
}: ReviewsTabProps) {
  const [depth, setDepth] = useState<20 | 50 | 100 | 200>(20);
  const [sortBy, setSortBy] = useState<
    "newest" | "highest_rating" | "lowest_rating" | "relevant"
  >("newest");
  const [includeOtherSources, setIncludeOtherSources] = useState(false);

  // Filters
  const [starFilter, setStarFilter] = useState<number | null>(null);
  const [withoutReplyOnly, setWithoutReplyOnly] = useState(false);
  const [page, setPage] = useState(1);

  const {
    fetch: currentFetch,
    isLoading,
    isTimedOut,
    refetch,
    history,
    startFetch,
    isStarting,
  } = useLocalFetch(brandKey, currentFetchId, business.id, "reviews");

  const items = useMemo<ReviewItem[]>(
    () => (currentFetch?.items as ReviewItem[]) ?? [],
    [currentFetch?.items]
  );

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      if (starFilter !== null) {
        if (item.rating?.value !== starFilter) return false;
      }
      if (withoutReplyOnly) {
        if (Boolean(item.owner_answer)) return false;
      }
      return true;
    });
  }, [items, starFilter, withoutReplyOnly]);

  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(filteredItems.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedItems = filteredItems.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize
  );

  // Metrics from items & totals
  const totalReviewsReported =
    currentFetch?.totals?.reviewsCount ?? items.length;
  const answeredCount = items.filter((r) => Boolean(r.owner_answer)).length;
  const avgRating =
    items.length > 0
      ? (
          items.reduce((sum, r) => sum + (r.rating?.value ?? 0), 0) /
          items.length
        ).toFixed(1)
      : null;

  const nextDepthMap: Record<number, 50 | 100 | 200 | null> = {
    20: 50,
    50: 100,
    100: 200,
    200: null,
  };
  // "Collect more" steps up from the collection on screen (which may be an
  // earlier, deeper one), not from the depth selector.
  const shownDepth = (currentFetch?.params?.depth ?? depth) as 20 | 50 | 100 | 200;
  const nextDepth = nextDepthMap[shownDepth] ?? null;

  const handleStart = async (maxUsd: number, overrideDepth?: 20 | 50 | 100 | 200) => {
    const d = overrideDepth ?? depth;
    const res = await startFetch({
      kind: "reviews",
      businessId: business.id,
      depth: d,
      sortBy: includeOtherSources ? undefined : sortBy,
      includeOtherSources,
      maxUsd,
    });
    if (res?.id) {
      onSelectFetchId(res.id);
      setPage(1);
    }
  };

  return (
    <div className="space-y-6" data-slot="reviews-tab">
      {/* Controls Card */}
      <div data-slot="reviews-controls">
        <CardShell title="Collect reviews">
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-4 items-end">
          <div className="space-y-1.5">
            <Label htmlFor="reviews-depth">Reviews to collect</Label>
            <Select
              value={String(depth)}
              onValueChange={(val) => setDepth(Number(val) as 20 | 50 | 100 | 200)}
            >
              <SelectTrigger id="reviews-depth">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="20">20</SelectItem>
                <SelectItem value="50">50</SelectItem>
                <SelectItem value="100">100</SelectItem>
                <SelectItem value="200">200</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="reviews-sort">Sort</Label>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger>
                  <div>
                    <Select
                      value={sortBy}
                      onValueChange={(val) => {
                        if (val) {
                          setSortBy(
                            val as "newest" | "highest_rating" | "lowest_rating" | "relevant"
                          );
                        }
                      }}
                      disabled={includeOtherSources}
                    >
                      <SelectTrigger id="reviews-sort">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="newest">Newest</SelectItem>
                        <SelectItem value="highest_rating">
                          Highest rating
                        </SelectItem>
                        <SelectItem value="lowest_rating">
                          Lowest rating
                        </SelectItem>
                        <SelectItem value="relevant">Most relevant</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </TooltipTrigger>
                {includeOtherSources && (
                  <TooltipContent>
                    Other sites can't be sorted.
                  </TooltipContent>
                )}
              </Tooltip>
            </TooltipProvider>
          </div>

          <div className="flex items-center space-x-2 pt-6">
            <Checkbox
              id="include-other-sources"
              checked={includeOtherSources}
              onCheckedChange={(checked) =>
                setIncludeOtherSources(Boolean(checked))
              }
            />
            <Label
              htmlFor="include-other-sources"
              className="text-xs font-normal cursor-pointer"
            >
              Include reviews from other sites (Yelp, Tripadvisor and others)
            </Label>
          </div>

          <div className="flex justify-end">
            <PricedActionButton
              label="Collect reviews"
              pendingLabel="Collecting…"
              brandKey={brandKey}
              action="local.reviews.collect"
              input={{
                businessId: business.id,
                depth,
                sortBy: includeOtherSources ? undefined : sortBy,
                includeOtherSources,
              }}
              pending={isStarting}
              onRun={(maxUsd) => handleStart(maxUsd)}
              dialogTitle="Collect Google reviews"
              confirmLabel="Collect reviews"
            />
          </div>
        </div>

        {history.length > 0 && (
          <div className="pt-4 border-t border-border flex items-center justify-between text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <span>Earlier collections:</span>
              <Select
                value={currentFetchId ?? history[0]?.id ?? ""}
                onValueChange={(val) => {
                  onSelectFetchId(val);
                  setPage(1);
                }}
              >
                <SelectTrigger className="w-64 h-8 text-xs">
                  <SelectValue placeholder="Select earlier collection" />
                </SelectTrigger>
                <SelectContent>
                  {history.map((h) => (
                    <SelectItem key={h.id} value={h.id} className="text-xs">
                      {new Date(h.createdAt).toLocaleDateString()} · {h.itemCount} reviews
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
      </CardShell>
      </div>

      {/* Review Content States */}
      {!currentFetch && !isLoading && !isStarting && (
        <EmptyState
          icon={MessageSquareQuote}
          title="No reviews collected yet"
          description="Collect reviews to see ratings, text and which ones your business replied to."
        />
      )}

      {(isLoading || isStarting || currentFetch?.status === "processing") && (
        <div data-slot="reviews-processing">
          <CardShell title="Collecting reviews">
          <div className="space-y-4" aria-live="polite">
            <div className="text-sm text-muted-foreground">
              Collecting reviews… This usually takes 20 to 60 seconds.
            </div>
            {isTimedOut && (
              <div className="rounded-md border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300 flex items-center justify-between">
                <span>
                  Still collecting. Come back later to collect it at no extra cost.
                </span>
                <Button size="sm" variant="outline" onClick={() => refetch()}>
                  Check again
                </Button>
              </div>
            )}
            <div className="space-y-3">
              <Skeleton className="h-28 w-full rounded-lg" />
              <Skeleton className="h-28 w-full rounded-lg" />
              <Skeleton className="h-28 w-full rounded-lg" />
            </div>
          </div>
        </CardShell>
        </div>
      )}

      {currentFetch?.status === "failed" && (
        <Alert variant="destructive" className="space-y-3" data-slot="reviews-failed">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            <span className="font-semibold">
              {currentFetch.error?.message ?? "Google data could not be collected. Try again later."}
            </span>
          </div>
          <div>
            <PricedActionButton
              label="Try again"
              pendingLabel="Collecting…"
              brandKey={brandKey}
              action="local.reviews.collect"
              input={{
                businessId: business.id,
                depth,
                sortBy: includeOtherSources ? undefined : sortBy,
                includeOtherSources,
              }}
              pending={isStarting}
              onRun={(maxUsd) => handleStart(maxUsd)}
              dialogTitle="Collect Google reviews"
              confirmLabel="Try again"
              variant="outline"
            />
          </div>
        </Alert>
      )}

      {currentFetch?.status === "completed" && (
        <div className="space-y-4" data-slot="reviews-completed">
          {/* Summary Banner */}
          <div className="rounded-lg border border-border bg-card p-4 space-y-2">
            <div className="text-sm font-medium text-foreground">
              Collected <strong>{items.length}</strong> of{" "}
              <strong>{totalReviewsReported}</strong> reviews · average ★{" "}
              {avgRating ?? "—"} of the collected · owner replied to{" "}
              <strong>
                {answeredCount} of {items.length}
              </strong>
            </div>

            {currentFetch.reused && (
              <div className="text-xs text-muted-foreground">
                Collected {Math.max(1, Math.round((Date.now() - new Date(currentFetch.createdAt).getTime()) / 60000))} minutes ago. Reused at no cost.
              </div>
            )}

            {/* Filter chips */}
            <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-border">
              <span className="text-xs text-muted-foreground">Rating:</span>
              <Button
                variant={starFilter === null ? "default" : "outline"}
                size="xs"
                onClick={() => {
                  setStarFilter(null);
                  setPage(1);
                }}
              >
                All
              </Button>
              {[5, 4, 3, 2, 1].map((s) => (
                <Button
                  key={s}
                  variant={starFilter === s ? "default" : "outline"}
                  size="xs"
                  onClick={() => {
                    setStarFilter(starFilter === s ? null : s);
                    setPage(1);
                  }}
                >
                  {s}★
                </Button>
              ))}

              <div className="ml-auto">
                <Button
                  variant={withoutReplyOnly ? "default" : "outline"}
                  size="xs"
                  onClick={() => {
                    setWithoutReplyOnly(!withoutReplyOnly);
                    setPage(1);
                  }}
                >
                  Without owner reply
                </Button>
              </div>
            </div>
          </div>

          {/* Cards List or Empty */}
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              This profile has no reviews matching the request.
            </p>
          ) : filteredItems.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No reviews match the selected filters.
            </p>
          ) : (
            <div className="space-y-3">
              {pagedItems.map((review, idx) => (
                <ReviewCard
                  key={review.review_id ?? `review-${idx}`}
                  review={review}
                />
              ))}

              {totalPages > 1 && (
                <div className="pt-2 flex justify-between items-center text-xs text-muted-foreground">
                  <span>
                    Page {currentPage} of {totalPages}
                  </span>
                  <TablePagination
                    page={currentPage}
                    pageSize={pageSize}
                    totalCount={filteredItems.length}
                    onPageChange={setPage}
                  />
                </div>
              )}

              {/* Below last page */}
              {currentPage === totalPages && (
                <div className="rounded-lg border border-border bg-muted/30 p-4 flex flex-wrap items-center justify-between gap-4 text-xs text-muted-foreground mt-4">
                  <span>
                    These are the {items.length} most recent of {totalReviewsReported} reviews.
                  </span>

                  {nextDepth && (
                    <PricedActionButton
                      label={`Collect up to ${nextDepth} reviews`}
                      pendingLabel="Collecting…"
                      brandKey={brandKey}
                      action="local.reviews.collect"
                      input={{
                        businessId: business.id,
                        depth: nextDepth,
                        sortBy: includeOtherSources ? undefined : sortBy,
                        includeOtherSources,
                      }}
                      pending={isStarting}
                      onRun={(maxUsd) => handleStart(maxUsd, nextDepth)}
                      dialogTitle={`Collect up to ${nextDepth} Google reviews`}
                      confirmLabel={`Collect up to ${nextDepth}`}
                      variant="outline"
                    />
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
