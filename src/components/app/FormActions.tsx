"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/FormActions.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { Button } from "@/components/ui/button";

/** The Cancel and submit buttons at the end of a form. */
export function FormActions({
  pending,
  disabled = false,
  onCancel,
  size = "default",
}: {
  pending: boolean;
  disabled?: boolean;
  onCancel: () => void;
  size?: "xs" | "sm" | "default";
}) {
  return (
    <div className="flex justify-end gap-2">
      <Button
        type="button"
        variant="ghost"
        size={size}
        onClick={onCancel}
        disabled={pending}
      >
        Cancel
      </Button>
      <Button type="submit" size={size} disabled={disabled} pending={pending}>
        Save
      </Button>
    </div>
  );
}
