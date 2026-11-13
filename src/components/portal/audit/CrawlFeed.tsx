// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/audit/AuditDetail.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

// F18 phase 4 — the live feed of crawled pages, newest first.

import { CardShell } from "@/components/app/CardShell";
import type { AuditFeedEntry } from "./hooks/useAuditFeed";
import { HttpStatusBadge, formatClockTime, pathOf } from "./shared";

export function CrawlFeed({ entries }: { entries: AuditFeedEntry[] }) {
  const newest = entries[0]?.crawledAt;

  return (
    <CardShell
      title={`Crawled pages (${entries.length})`}
      action={
        <span className="text-xs text-muted-foreground">
          {`Updated ${formatClockTime(newest)}`}
        </span>
      }
    >
      {entries.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">
          Waiting for the first page…
        </p>
      ) : (
        <ul
          aria-live="off"
          className="max-h-[400px] divide-y divide-border overflow-y-auto"
        >
          {entries.map((entry, index) => (
            <li
              key={`${entry.url}-${entry.crawledAt}`}
              className={
                index === 0
                  ? "flex items-center gap-3 bg-primary/5 px-1 py-2 animate-in fade-in slide-in-from-top-1"
                  : "flex items-center gap-3 px-1 py-2"
              }
            >
              <HttpStatusBadge statusCode={entry.statusCode} />
              <span
                className="min-w-0 flex-1 truncate text-sm"
                title={entry.url}
              >
                {pathOf(entry.url)}
              </span>
              <span className="hidden max-w-[260px] truncate text-sm text-muted-foreground md:block">
                {entry.title ?? ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </CardShell>
  );
}
