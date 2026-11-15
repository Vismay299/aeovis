"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/ai-visibility/shared.tsx:184-196
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { Badge } from "@/components/ui/badge";

export function MentionBadge({
  value,
  positive = "Mentioned",
  negative,
  size = "default",
}: {
  value: boolean | null | undefined;
  positive?: "Mentioned" | "Cited";
  negative?: string;
  size?: "default" | "sm";
}) {
  if (value === null || value === undefined) {
    return (
      <Badge variant="secondary" size={size}>
        Unknown
      </Badge>
    );
  }

  const defaultNegative = positive === "Cited" ? "Not cited" : "Not mentioned";
  const label = value ? positive : (negative ?? defaultNegative);

  return (
    <Badge variant={value ? "success" : "secondary"} size={size}>
      {label}
    </Badge>
  );
}
