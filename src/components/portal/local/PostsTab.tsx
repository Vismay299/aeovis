"use client";

import { useMemo, useState } from "react";
import { CardShell } from "@/components/app/CardShell";
import { EmptyState } from "@/components/app/EmptyState";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { PricedActionButton } from "@/components/app/cost/PricedActionButton";
import { SafeExternalLink } from "@/components/app/SafeExternalLink";
import { Newspaper, AlertCircle } from "lucide-react";
import type { SavedBusinessView } from "./hooks/useLocalBusinesses";
import { useLocalFetch } from "./hooks/useLocalFetch";

export type PostItem = {
  rank_absolute?: number;
  author?: string | null;
  post_date?: string | null;
  timestamp?: string | null;
  post_text?: string | null;
  snippet?: string | null;
  url?: string | null;
  links?: Array<{ title?: string; url?: string }> | null;
};

export type PostsTabProps = {
  brandKey: string;
  business: SavedBusinessView;
  currentFetchId: string | null;
  onSelectFetchId: (id: string | null) => void;
};

export function PostsTab({
  brandKey,
  business,
  currentFetchId,
  onSelectFetchId,
}: PostsTabProps) {
  const [depth, setDepth] = useState<10 | 20 | 50 | 100>(10);

  const {
    fetch: currentFetch,
    isLoading,
    isTimedOut,
    refetch,
    startFetch,
    isStarting,
  } = useLocalFetch(brandKey, currentFetchId, business.id, "updates");

  const items = useMemo<PostItem[]>(
    () => (currentFetch?.items as PostItem[]) ?? [],
    [currentFetch?.items]
  );

  const latestPost = items[0];

  const handleStart = async (maxUsd: number) => {
    const res = await startFetch({
      kind: "updates",
      businessId: business.id,
      depth,
      maxUsd,
    });
    if (res?.id) {
      onSelectFetchId(res.id);
    }
  };

  return (
    <div className="space-y-6" data-slot="posts-tab">
      <div data-slot="posts-controls">
        <CardShell title="Collect posts">
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 items-end">
          <div className="space-y-1.5">
            <Label htmlFor="posts-depth">Posts to collect</Label>
            <Select
              value={String(depth)}
              onValueChange={(val) => setDepth(Number(val) as 10 | 20 | 50 | 100)}
            >
              <SelectTrigger id="posts-depth">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="10">10</SelectItem>
                <SelectItem value="20">20</SelectItem>
                <SelectItem value="50">50</SelectItem>
                <SelectItem value="100">100</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex justify-start sm:col-span-2">
            <PricedActionButton
              label="Collect posts"
              pendingLabel="Collecting…"
              brandKey={brandKey}
              action="local.updates.collect"
              input={{
                businessId: business.id,
                depth,
              }}
              pending={isStarting}
              onRun={handleStart}
              dialogTitle="Collect Google Business posts"
              confirmLabel="Collect posts"
            />
          </div>
        </div>
      </CardShell>
      </div>

      {!currentFetch && !isLoading && !isStarting && (
        <EmptyState
          icon={Newspaper}
          title="No posts collected yet"
          description="Collect posts to see Google updates, news and announcements published by this profile."
        />
      )}

      {(isLoading || isStarting || currentFetch?.status === "processing") && (
        <div data-slot="posts-processing">
          <CardShell title="Collecting posts">
          <div className="space-y-4" aria-live="polite">
            <div className="text-sm text-muted-foreground">
              Collecting posts… This usually takes 20 to 60 seconds.
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
              <Skeleton className="h-24 w-full rounded-lg" />
              <Skeleton className="h-24 w-full rounded-lg" />
            </div>
          </div>
        </CardShell>
        </div>
      )}

      {currentFetch?.status === "failed" && (
        <Alert variant="destructive" className="space-y-3" data-slot="posts-failed">
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
              action="local.updates.collect"
              input={{
                businessId: business.id,
                depth,
              }}
              pending={isStarting}
              onRun={handleStart}
              dialogTitle="Collect Google Business posts"
              confirmLabel="Try again"
              variant="outline"
            />
          </div>
        </Alert>
      )}

      {currentFetch?.status === "completed" && (
        <div className="space-y-4" data-slot="posts-completed">
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              This profile has published no posts.
            </p>
          ) : (
            <>
              {latestPost && (
                <div className="rounded-lg border border-border bg-card p-3 text-xs text-muted-foreground">
                  Latest post {latestPost.post_date ?? latestPost.timestamp ?? "recently"}
                </div>
              )}

              <div className="space-y-3">
                {items.map((post, idx) => (
                  <div
                    key={post.rank_absolute ?? `post-${idx}`}
                    className="rounded-lg border border-border bg-card p-4 space-y-2"
                    data-slot="post-card"
                  >
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>{post.post_date ?? post.timestamp ?? "Post"}</span>
                    </div>

                    <p className="text-sm text-foreground whitespace-pre-wrap">
                      {post.post_text ?? post.snippet ?? ""}
                    </p>

                    {post.links && post.links.length > 0 && (
                      <div className="pt-2 border-t border-border flex flex-wrap gap-3 text-xs">
                        {post.links.map((link, lIdx) => (
                          link.url ? (
                            <SafeExternalLink
                              key={lIdx}
                              url={link.url}
                              label={`${link.title || "Link"} → ${link.url}`}
                              className="text-primary hover:underline"
                            />
                          ) : null
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
