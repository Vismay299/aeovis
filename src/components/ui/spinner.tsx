"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/ui/spinner.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { cn } from "@/shared/utils";

// A ring with an arc that stretches and catches up as it turns. The rotation
// and the arc both run in motion.css.
function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <svg
      data-slot="spinner"
      role="status"
      aria-label="Loading"
      viewBox="0 0 50 50"
      fill="none"
      className={cn("size-4", className)}
      {...props}
    >
      <circle cx="25" cy="25" r="20" stroke="currentColor" strokeOpacity="0.2" strokeWidth="5" />
      <circle
        data-arc
        cx="25"
        cy="25"
        r="20"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="round"
        strokeDasharray="90 150"
      />
    </svg>
  );
}

/** A tick that draws itself inside a filled disc. Plays once on mount. */
function SuccessCheck({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <svg
      data-slot="success-check"
      role="img"
      aria-label="Done"
      viewBox="0 0 24 24"
      fill="none"
      className={cn("size-4", className)}
      {...props}
    >
      <circle cx="12" cy="12" r="11" fill="currentColor" fillOpacity="0.18" />
      <path
        d="M7 12.5l3.2 3.2L17 9"
        pathLength={1}
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export { Spinner, SuccessCheck };
