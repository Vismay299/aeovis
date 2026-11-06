"use client";

import Link from "next/link";
import { PenLine } from "lucide-react";
import { Badge, Button, Card, EmptyState, SkeletonRows, formatRelative } from "../ui";
import { contentItemStatus } from "../status";

export default function ContentStudioCard({ overview }) {
  const items = overview ? (overview.content_items || []).slice(0, 5) : null;

  let body;
  if (!items) {
    body = <SkeletonRows rows={3} />;
  } else if (!items.length) {
    body = (
      <EmptyState
        icon={PenLine}
        title="No drafts yet"
        action={<Button href="/portal/content?new=1">Create a draft</Button>}
      >
        Turn a question you&apos;re losing into an article AI engines can cite.
      </EmptyState>
    );
  } else {
    body = (
      <div className="divide-y divide-border pv-list">
        {items.map((item) => {
          const status = contentItemStatus(item.status);
          const when = item.updated_at || item.created_at;
          return (
            <Link
              key={item.id}
              href={`/portal/content?item=${encodeURIComponent(item.id)}`}
              className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-muted/50 pv-list__row"
            >
              <span className="flex flex-col min-w-0 pv-list__main">
                <span className="text-sm font-medium text-foreground truncate pv-list__title">
                  {item.title || "Untitled draft"}
                </span>
                <span className="text-xs text-muted-foreground pv-list__meta">
                  {when ? `Updated ${formatRelative(when)}` : "Updated —"}
                </span>
              </span>
              <Badge tone={status.tone}>{status.label}</Badge>
            </Link>
          );
        })}
      </div>
    );
  }

  return (
    <Card
      title="Content Studio"
      description="Drafts for the questions you are losing"
      flush
      actions={<Button variant="ghost" size="sm" href="/portal/content">Open studio</Button>}
    >
      {body}
    </Card>
  );
}
