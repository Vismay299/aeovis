"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/projects/project-context/ProjectContextPage.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/app/EmptyState";
import {
  PROJECT_CONTEXT_SECTION_KEYS,
  PROJECT_CONTEXT_SECTION_LABELS,
  PROJECT_CONTEXT_SECTION_HINTS,
  PROJECT_CONTEXT_SECTION_PLACEHOLDERS,
  PROSE_MAX_CHARS,
  type ProjectContext,
  type ProjectContextSectionKey,
  type ProjectContextUpdate,
} from "@/shared/project-context";
import { Provenance } from "./Provenance";
import { useContextUpdate } from "./hooks/useProjectContext";

type StoredSection = ProjectContext["sections"][number];

export function ProseSections({
  brandKey,
  sections,
  missingSections,
  currentUserId,
}: {
  brandKey: string;
  sections: StoredSection[];
  missingSections: ProjectContextSectionKey[];
  currentUserId?: string | null;
}) {
  const update = useContextUpdate(brandKey);
  const stored = React.useMemo(
    () => new Map(sections.map((s) => [s.key, s])),
    [sections],
  );

  // Local drafts: only holds sections the user has typed into. Unmodified
  // sections update automatically on query refetch.
  const [drafts, setDrafts] = React.useState<
    Partial<Record<ProjectContextSectionKey, string>>
  >({});

  const draftOf = (key: ProjectContextSectionKey) =>
    drafts[key] ?? stored.get(key)?.content ?? "";

  const changed = PROJECT_CONTEXT_SECTION_KEYS.filter((key) => {
    if (drafts[key] === undefined) return false;
    return drafts[key] !== (stored.get(key)?.content ?? "");
  });

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (changed.length === 0 || update.isPending) return;

    const ops: ProjectContextUpdate[] = changed.map((key) => ({
      section: key,
      content: draftOf(key),
    }));

    update.mutate(ops, {
      onSuccess: () => {
        setDrafts((curr) => {
          const next = { ...curr };
          for (const k of changed) {
            delete next[k];
          }
          return next;
        });
      },
    });
  };

  return (
    <form
      className="space-y-6"
      aria-busy={update.isPending}
      onSubmit={onSubmit}
    >
      {missingSections.length === PROJECT_CONTEXT_SECTION_KEYS.length ? (
        <EmptyState
          size="sm"
          icon={null}
          title="Nothing written down yet"
          description="Fill in what you can, or run question setup to draft it from your website."
        />
      ) : null}

      {PROJECT_CONTEXT_SECTION_KEYS.map((key) => {
        const section = stored.get(key);
        return (
          <div key={key} className="space-y-1.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <label
                htmlFor={`context-${key}`}
                className="text-sm font-medium text-foreground"
              >
                {PROJECT_CONTEXT_SECTION_LABELS[key]}
              </label>
              {section ? (
                <Provenance
                  by={section.updatedBy}
                  at={section.updatedAt}
                  userId={section.updatedByUser}
                  currentUserId={currentUserId}
                />
              ) : (
                <span className="text-xs text-muted-foreground">Empty</span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {PROJECT_CONTEXT_SECTION_HINTS[key]}
            </p>
            <Textarea
              id={`context-${key}`}
              value={draftOf(key)}
              onChange={(event) => {
                const value = event.target.value;
                setDrafts((current) => {
                  if (value === (stored.get(key)?.content ?? "")) {
                    const { [key]: _dropped, ...rest } = current;
                    return rest;
                  }
                  return { ...current, [key]: value };
                });
              }}
              rows={4}
              maxLength={PROSE_MAX_CHARS}
              placeholder={PROJECT_CONTEXT_SECTION_PLACEHOLDERS[key]}
            />
          </div>
        );
      })}

      <div className="flex justify-end">
        <Button
          type="submit"
          size="sm"
          disabled={update.isPending || changed.length === 0}
        >
          Save changes
        </Button>
      </div>
    </form>
  );
}
