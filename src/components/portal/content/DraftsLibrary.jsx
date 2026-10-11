"use client";

import { useMemo, useState } from "react";
import { FileText } from "lucide-react";
import { Badge, Card, EmptyState, SkeletonRows, Tabs, formatRelative } from "../ui";
import { contentItemStatus } from "../status";
import { playbookLabel } from "./shared";

const FILTERS = {
  all: { label: "All", status: null },
  review: { label: "Needs review", status: "awaiting_approval" },
  approved: { label: "Approved", status: "approved" },
  rejected: { label: "Rejected", status: "rejected" },
};

/** The drafts library: every draft for this workspace, filterable by review state. */
export default function DraftsLibrary({ items, onOpen }) {
  const [filter, setFilter] = useState("all");

  const tabs = useMemo(() => Object.entries(FILTERS).map(([value, entry]) => ({
    value,
    label: entry.label,
    count: items ? (entry.status ? items.filter((item) => item.status === entry.status).length : items.length) : undefined,
  })), [items]);

  const visible = useMemo(() => {
    if (!items) return [];
    const status = FILTERS[filter].status;
    return status ? items.filter((item) => item.status === status) : items;
  }, [items, filter]);

  return (
    <Card flush title="Drafts" description="Open a draft to edit, preview and review it.">
      <div className="pv-content-tabs-row">
        <Tabs items={tabs} value={filter} onChange={setFilter} label="Filter drafts" />
      </div>
      {items === null ? <SkeletonRows rows={4} /> : null}
      {items && items.length === 0 ? (
        <EmptyState icon={FileText} title="No drafts yet">
          Create your first draft from the panel on the right.
        </EmptyState>
      ) : null}
      {items && items.length > 0 && visible.length === 0 ? (
        <p className="pv-content-quiet">No drafts in this view.</p>
      ) : null}
      {visible.length > 0 ? (
        <div className="pv-list">
          {visible.map((item) => {
            const status = contentItemStatus(item.status);
            const meta = [playbookLabel(item.playbook), `Updated ${formatRelative(item.updated_at)}`].filter(Boolean).join(" · ");
            return (
              <button key={item.id} type="button" className="pv-list__row pv-content-row" onClick={() => onOpen(item.id)}>
                <span className="pv-list__main">
                  <span className="pv-list__title">{item.title || "Untitled draft"}</span>
                  <span className="pv-list__meta">{meta}</span>
                </span>
                <Badge tone={status.tone}>{status.label}</Badge>
              </button>
            );
          })}
        </div>
      ) : null}
    </Card>
  );
}
