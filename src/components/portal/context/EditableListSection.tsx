"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/projects/project-context/EditableListSection.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useState, type ReactNode } from "react";
import { Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/app/EmptyState";
import { InlineConfirm } from "@/components/app/InlineConfirm";
import { SectionHeader } from "@/components/app/PageHeader";
import { nextEditingId, listClass } from "./editableList";

export function RowActions({ children }: { children: ReactNode }) {
  return <div className="flex shrink-0 items-center gap-1">{children}</div>;
}

/** The same add, edit, and remove interaction for both context lists. */
export function EditableListSection<T>({
  title,
  hint,
  addLabel,
  emptyTitle,
  emptyDescription,
  items,
  getId,
  getLabel,
  renderItem,
  renderForm,
  onRemove,
  pending,
}: {
  title: string;
  hint: string;
  addLabel: string;
  emptyTitle: string;
  emptyDescription: string;
  items: T[];
  getId: (item: T) => string;
  getLabel: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  renderForm: (item: T | undefined, close: () => void) => ReactNode;
  onRemove: (item: T) => void;
  pending: boolean;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const close = () => setEditing(null);

  return (
    <section className="space-y-3">
      <SectionHeader
        title={title}
        hint={hint}
        action={
          <Button
            variant="ghost"
            size="xs"
            disabled={pending}
            onClick={() => setEditing((curr) => nextEditingId(curr, "add"))}
          >
            <Plus className="size-3.5" />
            {addLabel}
          </Button>
        }
      />
      {editing === "add" ? (
        <div className={listClass}>{renderForm(undefined, close)}</div>
      ) : null}
      {items.length === 0 ? (
        editing === "add" ? null : (
          <EmptyState
            size="sm"
            icon={null}
            title={emptyTitle}
            description={emptyDescription}
          />
        )
      ) : (
        <ul className={listClass}>
          {items.map((item) => {
            const id = getId(item);
            return editing === id ? (
              <li key={id}>{renderForm(item, close)}</li>
            ) : (
              <li
                key={id}
                className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 p-3"
              >
                {renderItem(item)}
                <RowActions>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={pending}
                    aria-label={`Edit ${getLabel(item)}`}
                    onClick={() => setEditing((curr) => nextEditingId(curr, id))}
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                  <InlineConfirm
                    label={`Remove ${getLabel(item)}`}
                    pending={pending}
                    onConfirm={() => onRemove(item)}
                  />
                </RowActions>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
