"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/table/url.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { ExternalLink } from "lucide-react";
import { resolveUrlHref } from "@/shared/table/url";

export function ExternalUrlCell({
  value,
  label,
  baseDomain,
}: {
  value: string | null | undefined;
  label: string;
  baseDomain?: string;
}) {
  const href = resolveUrlHref(value, baseDomain);
  if (!value || !href) {
    return <span className="text-muted-foreground">-</span>;
  }

  return (
    <a
      className="inline-flex max-w-full items-center gap-1 text-primary underline-offset-4 hover:underline"
      href={href}
      target="_blank"
      rel="noreferrer"
    >
      <span className="truncate">{label}</span>
      <ExternalLink className="size-3 shrink-0" />
    </a>
  );
}
