"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/ui/checkbox.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { cn } from "@/shared/utils";

function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "group/checkbox peer relative flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input outline-none group-has-disabled/field:opacity-50 group-has-[:focus-visible]/field-label:ring-0 group-has-[:focus-visible]/field-label:not-data-checked:border-input after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-disabled:cursor-not-allowed data-disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 aria-invalid:aria-checked:border-primary dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-checked:border-primary data-checked:text-primary-foreground data-indeterminate:border-primary data-indeterminate:text-primary-foreground group-has-[:focus-visible]/field-label:data-checked:border-primary",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        keepMounted
        data-slot="checkbox-indicator"
        className="absolute inset-0 grid place-content-center rounded-[inherit] text-current"
      >
        {/* One stroke drawn to length: a tick, or a dash when indeterminate. */}
        <svg viewBox="0 0 16 16" fill="none" aria-hidden className="size-[88%]">
          <path
            data-slot="check-path"
            pathLength={1}
            d="M3.6 8.5l2.9 2.9 5.9-6.6"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="group-data-indeterminate/checkbox:hidden"
          />
          <path
            data-slot="check-path"
            pathLength={1}
            d="M4 8h8"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            className="hidden group-data-indeterminate/checkbox:block"
          />
        </svg>
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
