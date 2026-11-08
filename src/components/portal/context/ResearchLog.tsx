"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/projects/project-context/ProjectContextPage.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { InlineConfirm } from "@/components/app/InlineConfirm";
import { SectionHeader } from "@/components/app/PageHeader";
import { EmptyState } from "@/components/app/EmptyState";
import { formatUsd } from "@/shared/money";
import type { ProjectContext } from "@/shared/project-context";
import { listClass } from "./editableList";
import { RowActions } from "./EditableListSection";
import { Provenance } from "./Provenance";
import { useContextUpdate } from "./hooks/useProjectContext";

type LogEntry = ProjectContext["researchLog"][number];

export function ResearchLog({
  brandKey,
  researchLog,
  currentUserId,
}: {
  brandKey: string;
  researchLog: LogEntry[];
  currentUserId?: string | null;
}) {
  const update = useContextUpdate(brandKey);

  return (
    <section className="space-y-3">
      <SectionHeader
        title="Research log"
        hint="Paid research already bought for this workspace, so nobody buys the same data twice."
      />

      {researchLog.length === 0 ? (
        <EmptyState
          size="sm"
          icon={null}
          title="Nothing logged yet"
          description="Question setup and research tools record what they bought here."
        />
      ) : (
        <ul className={listClass}>
          {researchLog.map((entry) => (
            <li
              key={entry.id}
              className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 p-3"
            >
              <div className="min-w-0 space-y-0.5">
                <p className="text-sm text-foreground">{entry.summary}</p>
                <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
                  <span>{entry.entryDate}</span>
                  {entry.spendUsd != null ? (
                    <>
                      <span>·</span>
                      <span>{formatUsd(entry.spendUsd)}</span>
                    </>
                  ) : null}
                  <span>·</span>
                  <Provenance
                    by={entry.createdBy}
                    currentUserId={currentUserId}
                  />
                </div>
              </div>
              <RowActions>
                <InlineConfirm
                  label={`Delete log entry from ${entry.entryDate}`}
                  confirmLabel="Delete"
                  pending={update.isPending}
                  onConfirm={() =>
                    update.mutate([{ removeResearchLog: [entry.id] }])
                  }
                />
              </RowActions>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
