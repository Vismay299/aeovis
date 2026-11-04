"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/SafeExternalLink.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { ExternalLink } from "lucide-react";
import { safeHttpUrl } from "@/shared/safe-url";

export function SafeExternalLink({
  url,
  label,
  className,
}: {
  url: string;
  label: string;
  className: string;
}) {
  const safeUrl = safeHttpUrl(url);
  if (!safeUrl) {
    return <span className={className}>{label}</span>;
  }

  return (
    <a className={className} href={safeUrl} target="_blank" rel="noreferrer">
      {label}
      <ExternalLink className="size-3 shrink-0" />
    </a>
  );
}
