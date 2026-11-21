"use client";

import type { SVGProps } from "react";
import { cn } from "@/shared/utils";
import {
  MARK_LOWER,
  MARK_UPPER,
  MARK_VIEWBOX,
  WORDMARK_GLYPHS,
  WORDMARK_VIEWBOX,
} from "./logoGeometry";

// Both pieces draw in currentColor, so the logo follows the text colour of
// whatever surface it sits on.
/**
 * The Essence P mark. Sized by height through `className`; a square box such
 * as `size-10` centres it. `animated` plays the two-panel rise once on mount.
 */
export function PerceevMark({
  className,
  animated = true,
  ...props
}: SVGProps<SVGSVGElement> & { animated?: boolean }) {
  return (
    <svg
      viewBox={MARK_VIEWBOX}
      fill="currentColor"
      aria-hidden="true"
      data-slot="perceev-mark"
      data-animated={animated ? "" : undefined}
      className={cn("inline-block h-[22px] w-auto shrink-0", className)}
      {...props}
    >
      <path className="perceev-mark__lower" d={MARK_LOWER} />
      <path className="perceev-mark__upper" d={MARK_UPPER} />
    </svg>
  );
}

/** The mark as a loading indicator: its two panels breathe in turn. */
export function PerceevLoader({
  className,
  label = "Loading",
}: {
  className?: string;
  label?: string;
}) {
  return (
    <svg
      viewBox={MARK_VIEWBOX}
      fill="currentColor"
      role="status"
      aria-label={label}
      data-slot="perceev-loader"
      className={cn("inline-block h-9 w-auto shrink-0", className)}
    >
      <path className="perceev-mark__lower" d={MARK_LOWER} />
      <path className="perceev-mark__upper" d={MARK_UPPER} />
    </svg>
  );
}

/**
 * The loader for a whole page or pane that is taking a while: sign-in
 * finishing, a route still loading. It stays hidden for the first 300ms so a
 * quick load never flashes it.
 */
export function PageLoader({
  className,
  label = "Loading",
}: {
  className?: string;
  label?: string;
}) {
  return (
    <div data-slot="page-loader" className={cn("flex h-full min-h-[60dvh] w-full items-center justify-center", className)}>
      <PerceevLoader label={label} className="h-12" />
    </div>
  );
}

/** The outlined "Perceev" wordmark. */
export function PerceevWordmark({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox={WORDMARK_VIEWBOX}
      fill="currentColor"
      aria-hidden="true"
      data-slot="perceev-wordmark"
      className={cn("inline-block h-[15px] w-auto shrink-0", className)}
      {...props}
    >
      <g transform="scale(1 -1)">
        {WORDMARK_GLYPHS.map(([x, d]) => (
          <path key={x} d={d} transform={`translate(${x} 0)`} />
        ))}
      </g>
    </svg>
  );
}

/** The horizontal logo: mark and wordmark in one colour. */
export function PerceevLogo({
  size = "md",
  className,
}: {
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const mark = size === "lg" ? "h-9" : size === "sm" ? "h-[22px]" : "h-[26px]";
  const word = size === "lg" ? "h-[21px]" : size === "sm" ? "h-[13px]" : "h-[15px]";
  return (
    <span
      role="img"
      aria-label="Perceev"
      data-slot="perceev-logo"
      className={cn(
        "group/logo inline-flex items-center",
        size === "lg" ? "gap-2.5" : "gap-2",
        className,
      )}
    >
      <PerceevMark className={mark} />
      <PerceevWordmark className={word} />
    </span>
  );
}
