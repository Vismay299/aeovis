"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/HelpLabel.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * A label with a help tooltip, for table headers and stat labels. The trigger
 * is a span, so it can sit inside a sort button.
 */
export function HelpLabel({
  label,
  helpText,
}: {
  label: string;
  helpText: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger delay={150} render={<span />}>
        {label}
      </TooltipTrigger>
      <TooltipContent>{helpText}</TooltipContent>
    </Tooltip>
  );
}
