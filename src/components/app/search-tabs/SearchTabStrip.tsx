"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/search-tabs/SearchTabStrip.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import type { SearchTab } from "@/shared/query/searchTabsState";

export type SearchTabQueryConfig = {
  queryKey: readonly unknown[];
  staleTime?: number;
  gcTime?: number;
};

export type SearchTabStripProps<I> = {
  tabs: SearchTab<I>[];
  activeTabId: string | null;
  onSelect: (tab: SearchTab<I>) => void;
  onClose: (tabId: string) => void;
  onViewed: (tabId: string, when?: number) => void;
  getQueryConfig: (tab: SearchTab<I>) => SearchTabQueryConfig;
};

export function SearchTabStrip<I>({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onViewed,
  getQueryConfig,
}: SearchTabStripProps<I>) {
  if (tabs.length === 0) return null;

  return (
    <div className="rounded-xl border border-border bg-card p-1">
      <div
        role="tablist"
        aria-label="Search tabs"
        className="flex min-w-0 items-stretch gap-1 overflow-x-auto"
      >
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              data-search-tab-id={tab.id}
              className={`group flex shrink-0 items-stretch overflow-hidden rounded-md text-sm transition ${
                active
                  ? "bg-muted text-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
              }`}
            >
              <button
                type="button"
                role="tab"
                data-search-tab-id={tab.id}
                aria-selected={active}
                className="flex min-w-0 items-center gap-1.5 px-2.5 py-1.5 text-left"
                onClick={() => onSelect(tab)}
              >
                <SearchTabStatus
                  tab={tab}
                  active={active}
                  onViewed={onViewed}
                  getQueryConfig={getQueryConfig}
                />
                <span
                  className="max-w-[10rem] truncate font-medium"
                  title={tab.label}
                >
                  {tab.label}
                </span>
              </button>
              <button
                type="button"
                data-search-tab-id={tab.id}
                className="flex items-center px-1.5 text-muted-foreground opacity-60 transition hover:bg-foreground/10 hover:text-foreground hover:opacity-100 group-hover:opacity-100"
                onClick={() => onClose(tab.id)}
                aria-label={`Close ${tab.label} tab`}
              >
                <X className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SearchTabStatus<I>({
  tab,
  active,
  onViewed,
  getQueryConfig,
}: {
  tab: SearchTab<I>;
  active: boolean;
  onViewed: (tabId: string, when?: number) => void;
  getQueryConfig: (tab: SearchTab<I>) => SearchTabQueryConfig;
}) {
  const config = getQueryConfig(tab);
  const query = useQuery({
    queryKey: config.queryKey,
    enabled: false,
    select: () => null,
    notifyOnChangeProps: ["dataUpdatedAt", "fetchStatus", "status"],
    staleTime: config.staleTime,
    gcTime: config.gcTime,
  });

  const isLoading = query.fetchStatus === "fetching";
  const hasResult = query.dataUpdatedAt > 0;
  const hasError = query.status === "error";
  const unviewed =
    !active &&
    hasResult &&
    (tab.viewedAt === null || tab.viewedAt < query.dataUpdatedAt);

  useEffect(() => {
    if (!active) return;
    if (!hasResult) return;
    if (tab.viewedAt !== null && tab.viewedAt >= query.dataUpdatedAt) return;
    onViewed(tab.id, query.dataUpdatedAt);
  }, [active, hasResult, onViewed, query.dataUpdatedAt, tab.id, tab.viewedAt]);

  const status = isLoading
    ? "loading"
    : hasError
      ? "error"
      : unviewed
        ? "unviewed"
        : "idle";

  return <SearchTabStatusIndicator status={status} />;
}

function SearchTabStatusIndicator({
  status,
}: {
  status: "idle" | "loading" | "unviewed" | "error";
}) {
  return (
    <span
      className="flex w-3.5 shrink-0 items-center justify-center"
      aria-hidden
    >
      {status === "loading" ? (
        <Spinner className="size-3 text-muted-foreground" />
      ) : status === "error" ? (
        <span className="size-2 rounded-full bg-destructive" />
      ) : status === "unviewed" ? (
        <span className="size-2 rounded-full bg-primary" />
      ) : null}
    </span>
  );
}
