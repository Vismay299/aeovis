"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/CopyButton.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { ComponentProps } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCopy } from "@/components/app/hooks/useCopy";

type ButtonProps = ComponentProps<typeof Button>;

/**
 * A Button that copies `value`. An `icon*` size shows only the icon and uses
 * `label` as the accessible name.
 */
export function CopyButton({
  value,
  successMessage,
  label = "Copy",
  onCopy,
  variant = "outline",
  size = "xs",
  className,
}: {
  value: string;
  successMessage: string;
  label?: string;
  onCopy?: () => void;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
}) {
  const { copied, copy } = useCopy();
  const iconOnly = size?.startsWith("icon") ?? false;
  const Icon = copied ? Check : Copy;

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={className}
      aria-label={iconOnly ? label : undefined}
      onClick={() => {
        void copy(value, successMessage).then((ok) => {
          if (ok) onCopy?.();
        });
      }}
    >
      <Icon
        data-icon={iconOnly ? undefined : "inline-start"}
        className={copied && variant !== "default" ? "text-success" : undefined}
        aria-hidden
      />
      {iconOnly ? null : copied ? "Copied" : label}
    </Button>
  );
}
