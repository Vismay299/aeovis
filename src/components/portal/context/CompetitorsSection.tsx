"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/projects/project-context/CompetitorsSection.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { FormActions } from "@/components/app/FormActions";
import { SafeExternalLink } from "@/components/app/SafeExternalLink";
import type {
  ProjectContext,
  ProjectContextUpdate,
} from "@/shared/project-context";
import { EditableListSection } from "./EditableListSection";
import { Provenance } from "./Provenance";
import { useContextUpdate } from "./hooks/useProjectContext";

type ContextCompetitor = ProjectContext["competitors"][number];
type CompetitorDraft = { domain: string; name: string; notes: string };

export function CompetitorsSection({
  brandKey,
  competitors,
  currentUserId,
}: {
  brandKey: string;
  competitors: ContextCompetitor[];
  currentUserId?: string | null;
}) {
  const update = useContextUpdate(brandKey);

  const save = (
    previousDomain: string | null,
    draft: CompetitorDraft,
    close: () => void,
  ) => {
    const ops: ProjectContextUpdate[] = [];
    const domain = draft.domain.trim();
    if (previousDomain && previousDomain !== domain) {
      ops.push({ removeCompetitors: [previousDomain] });
    }
    const name = draft.name.trim() || undefined;
    const notes = draft.notes.trim() || undefined;
    ops.push({
      addCompetitors: [
        {
          domain,
          ...(name ? { name } : {}),
          ...(notes ? { notes } : {}),
        },
      ],
    });
    update.mutate(ops, { onSuccess: close });
  };

  return (
    <EditableListSection
      title="Competitors"
      hint="The sites you measure yourself against. Question setup, the assistant and Content Studio use this list. Scan results still find competitors in the answers themselves."
      addLabel="Add competitor"
      emptyTitle="No competitors yet"
      emptyDescription="Add the sites you compete with, or run question setup to find them."
      items={competitors}
      getId={(item) => item.id}
      getLabel={(item) => item.domain}
      pending={update.isPending}
      onRemove={(item) => update.mutate([{ removeCompetitors: [item.domain] }])}
      renderItem={(item) => (
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="truncate text-sm font-medium">{item.domain}</span>
            {item.name ? (
              <span className="truncate text-xs text-muted-foreground">
                {item.name}
              </span>
            ) : null}
            {item.source === "setup_research" ? (
              <Badge variant="outline" size="sm">
                Found by setup
              </Badge>
            ) : null}
            {item.sourceUrl ? (
              <SafeExternalLink
                url={item.sourceUrl}
                label="Source"
                className="text-xs text-primary underline-offset-4 hover:underline inline-flex items-center gap-1"
              />
            ) : null}
          </div>
          {item.notes ? (
            <p className="text-sm text-muted-foreground">{item.notes}</p>
          ) : null}
          <Provenance
            by={item.updatedBy}
            at={item.updatedAt}
            userId={item.updatedByUser}
            currentUserId={currentUserId}
          />
        </div>
      )}
      renderForm={(item, close) => (
        <CompetitorForm
          initial={item}
          pending={update.isPending}
          onCancel={close}
          onSave={(draft) => save(item?.domain ?? null, draft, close)}
        />
      )}
    />
  );
}

function CompetitorForm({
  initial,
  pending,
  onCancel,
  onSave,
}: {
  initial?: ContextCompetitor;
  pending: boolean;
  onCancel: () => void;
  onSave: (draft: CompetitorDraft) => void;
}) {
  const [draft, setDraft] = React.useState<CompetitorDraft>({
    domain: initial?.domain ?? "",
    name: initial?.name ?? "",
    notes: initial?.notes ?? "",
  });

  return (
    <form
      className="space-y-2 bg-muted/40 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!draft.domain.trim() || pending) return;
        onSave(draft);
      }}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <Input
          autoFocus
          value={draft.domain}
          onChange={(event) =>
            setDraft({ ...draft, domain: event.target.value })
          }
          placeholder="competitor.com"
          maxLength={255}
          aria-label="Competitor domain"
        />
        <Input
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          placeholder="Name (optional)"
          maxLength={120}
          aria-label="Competitor name"
        />
      </div>
      <Input
        value={draft.notes}
        onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
        placeholder="Why they matter (optional)"
        maxLength={500}
        aria-label="Competitor notes"
      />
      <FormActions
        pending={pending}
        disabled={!draft.domain.trim()}
        onCancel={onCancel}
        size="xs"
      />
    </form>
  );
}
