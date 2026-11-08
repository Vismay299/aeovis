"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/projects/project-context/KeyPagesSection.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { FormActions } from "@/components/app/FormActions";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  KEY_PAGE_ROLES,
  KEY_PAGE_ROLE_LABELS,
  type KeyPageRole,
  type ProjectContext,
  type ProjectContextUpdate,
} from "@/shared/project-context";
import { EditableListSection } from "./EditableListSection";
import { Provenance } from "./Provenance";
import { useContextUpdate } from "./hooks/useProjectContext";

type ContextKeyPage = ProjectContext["keyPages"][number];
type KeyPageDraft = {
  url: string;
  role: KeyPageRole;
  topic: string;
  notes: string;
};

export function KeyPagesSection({
  brandKey,
  keyPages,
  currentUserId,
}: {
  brandKey: string;
  keyPages: ContextKeyPage[];
  currentUserId?: string | null;
}) {
  const update = useContextUpdate(brandKey);

  const save = (
    previousUrl: string | null,
    draft: KeyPageDraft,
    close: () => void,
  ) => {
    const ops: ProjectContextUpdate[] = [];
    const url = draft.url.trim();
    if (previousUrl && previousUrl !== url) {
      ops.push({ removeKeyPages: [previousUrl] });
    }
    const topic = draft.topic.trim() || undefined;
    const notes = draft.notes.trim() || undefined;
    ops.push({
      addKeyPages: [
        {
          url,
          role: draft.role,
          ...(topic ? { topic } : {}),
          ...(notes ? { notes } : {}),
        },
      ],
    });
    update.mutate(ops, { onSuccess: close });
  };

  return (
    <EditableListSection
      title="Key pages"
      hint="A shortlist of the pages that carry the site, not an inventory."
      addLabel="Add page"
      emptyTitle="No key pages yet"
      emptyDescription="Add the handful of pages that have to win: hubs, supporting pages and money pages."
      items={keyPages}
      getId={(item) => item.id}
      getLabel={(item) => item.url}
      pending={update.isPending}
      onRemove={(item) => update.mutate([{ removeKeyPages: [item.url] }])}
      renderItem={(item) => (
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="truncate text-sm font-medium">{item.url}</span>
            <Badge variant="secondary" size="sm">
              {KEY_PAGE_ROLE_LABELS[item.role]}
            </Badge>
          </div>
          {item.topic ? (
            <p className="text-sm text-muted-foreground">
              Target: {item.topic}
            </p>
          ) : null}
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
        <KeyPageForm
          initial={item}
          pending={update.isPending}
          onCancel={close}
          onSave={(draft) => save(item?.url ?? null, draft, close)}
        />
      )}
    />
  );
}

function KeyPageForm({
  initial,
  pending,
  onCancel,
  onSave,
}: {
  initial?: ContextKeyPage;
  pending: boolean;
  onCancel: () => void;
  onSave: (draft: KeyPageDraft) => void;
}) {
  const [draft, setDraft] = React.useState<KeyPageDraft>({
    url: initial?.url ?? "",
    role: initial?.role ?? "other",
    topic: initial?.topic ?? "",
    notes: initial?.notes ?? "",
  });

  return (
    <form
      className="space-y-2 bg-muted/40 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!draft.url.trim() || pending) return;
        onSave(draft);
      }}
    >
      <Input
        autoFocus
        value={draft.url}
        onChange={(event) => setDraft({ ...draft, url: event.target.value })}
        placeholder="offcult.in/collections/oversized-tees"
        maxLength={2048}
        aria-label="Page URL"
      />
      <div className="grid gap-2 sm:grid-cols-2">
        <Select
          value={draft.role}
          onValueChange={(val) => {
            if (val) setDraft({ ...draft, role: val as KeyPageRole });
          }}
        >
          <SelectTrigger className="w-full" aria-label="Page role">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {KEY_PAGE_ROLES.map((role) => (
              <SelectItem key={role} value={role}>
                {KEY_PAGE_ROLE_LABELS[role]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={draft.topic}
          onChange={(event) =>
            setDraft({ ...draft, topic: event.target.value })
          }
          placeholder="Target topic (optional)"
          maxLength={200}
          aria-label="Target topic"
        />
      </div>
      <Input
        value={draft.notes}
        onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
        placeholder="Notes (optional)"
        maxLength={500}
        aria-label="Page notes"
      />
      <FormActions
        pending={pending}
        disabled={!draft.url.trim()}
        onCancel={onCancel}
        size="xs"
      />
    </form>
  );
}
