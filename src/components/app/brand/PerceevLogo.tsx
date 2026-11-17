"use client";

import type { HTMLAttributes } from "react";
import { cn } from "@/shared/utils";

/**
 * Perceev 22px mark: rounded 7px, brand gradient with subtle inset ring.
 */
export function PerceevMark({ className, style, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-[22px] shrink-0 rounded-[7px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.18)]",
        className
      )}
      style={{
        background: "linear-gradient(135deg, var(--brand, #3730ce) 0%, var(--brand-lift, #4f46e5) 100%)",
        ...style,
      }}
      {...props}
    />
  );
}

/**
 * Perceev Logo: Mark + "perceev" wordmark in Archivo font.
 */
export function PerceevLogo({
  size = "md",
  className,
}: {
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <PerceevMark />
      <span
        style={{
          fontFamily: "'Archivo', system-ui, sans-serif",
          fontWeight: 750,
          letterSpacing: "-0.05em",
          fontSize: size === "sm" ? "16px" : "18px",
        }}
        className="leading-none text-foreground tracking-tight"
      >
        perceev
      </span>
    </span>
  );
}
