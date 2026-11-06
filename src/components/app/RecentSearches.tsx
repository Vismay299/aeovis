"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/RecentSearches.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { ReactNode } from "react";
import { Clock, History, X, type LucideIcon } from "lucide-react";
import { EmptyState } from "@/components/app/EmptyState";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

// Props for the caller's clickable element. Spread them onto a <Link> so
// cmd+click and "open in new tab" work, or onto a <button> for in-page state.
export type ClickableProps = { className: string; children: ReactNode };

export type RecentSearchesProps<TItem extends { timestamp: number }> = {
  items: TItem[];
  loaded: boolean;
  onRemove: (timestamp: number) => void;
  renderLink: (item: TItem, props: ClickableProps) => ReactNode;
  getTitle: (item: TItem) => ReactNode;
  getSubtitle?: (item: TItem) => ReactNode;
  emptyIcon?: LucideIcon;
  emptyTitle: string;
  emptyDescription?: string;
};

export function RecentSearches<TItem extends { timestamp: number }>({
  items,
  loaded,
  onRemove,
  renderLink,
  getTitle,
  getSubtitle,
  emptyIcon,
  emptyTitle,
  emptyDescription,
}: RecentSearchesProps<TItem>) {
  if (!loaded) {
    return null;
  }

  if (items.length === 0) {
    return (
      <EmptyState
        icon={emptyIcon}
        title={emptyTitle}
        description={emptyDescription}
      />
    );
  }

  return (
    <Card size="lg">
      <CardHeader className="flex items-center gap-2 text-muted-foreground">
        <History className="size-4" aria-hidden />
        {items.length} recent search{items.length !== 1 ? "es" : ""}
      </CardHeader>

      <CardContent>
        <ul className="grid gap-2">
          {items.map((item) => (
            <li
              key={item.timestamp}
              className="group flex min-w-0 items-center gap-2 rounded-lg border border-border p-2"
            >
              {renderLink(item, {
                className:
                  "flex min-w-0 flex-1 items-center gap-3 rounded-md px-1 py-1 text-left transition-colors outline-none hover:bg-foreground/5 focus-visible:ring-3 focus-visible:ring-ring/50",
                children: (
                  <>
                    <Clock
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                    <div className="min-w-0">
                      <p className="truncate font-medium">{getTitle(item)}</p>
                      {getSubtitle?.(item) ? (
                        <p className="truncate text-muted-foreground">
                          {getSubtitle(item)}
                        </p>
                      ) : null}
                    </div>
                  </>
                ),
              })}
              <div className="flex shrink-0 items-center gap-1">
                <span className="text-xs text-muted-foreground">
                  {new Date(item.timestamp).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="reveal-on-hover"
                  onClick={() => onRemove(item.timestamp)}
                  aria-label="Remove from recent searches"
                >
                  <X />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
