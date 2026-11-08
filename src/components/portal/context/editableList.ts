// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/projects/project-context/EditableListSection.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

export const listClass =
  "divide-y divide-border overflow-hidden rounded-lg border border-border bg-card";

/**
 * Resolves the next editing item ID for an editable list section.
 * - Passing `null` closes the editor.
 * - Clicking the currently active item toggles it closed (`null`).
 * - Clicking another item or `"add"` activates that item.
 */
export function nextEditingId(
  current: string | null,
  target: string | null,
): string | null {
  if (target === null) return null;
  return current === target ? null : target;
}
