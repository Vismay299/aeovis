"use client";

import type { ReactNode } from "react";
import { cn } from "@/shared/utils";

/**
 * T8 — the locked empty-state drawing, taken from Kokonut's Empty State
 * (`src/components/kokonutui/empty-state.tsx`): two blank cards fan out
 * behind a dashed card that carries the region's own icon, and lean further
 * apart while the empty state's action is hovered or focused.
 *
 * Only the drawing comes across. The vendored component is a project-creation
 * playground with sample projects; nothing here invents content — the cards
 * are blank shapes and the icon is the caller's.
 *
 * Motion is CSS (`[data-slot="empty-art"]` in motion.css), so the drawing
 * renders on the server in its final pose, the entrance only replays from
 * there, and reduced motion leaves it still and fully visible.
 */
export function EmptyArt({
  children,
  tone = "default",
  size = "default",
  className,
}: {
  /** The icon shown on the front card. */
  children?: ReactNode;
  tone?: "default" | "error";
  size?: "sm" | "default" | "lg";
  className?: string;
}) {
  return (
    <div
      data-slot="empty-art"
      data-tone={tone}
      data-size={size}
      aria-hidden
      className={cn(
        // Every measure is in em, so one font size scales the whole drawing.
        "relative h-[5.75em] w-[9.375em] shrink-0 text-[16px] data-[size=lg]:text-[18px] data-[size=sm]:text-[12px]",
        className,
      )}
    >
      <span
        data-slot="empty-art-card"
        data-side="start"
        className="absolute inset-x-[1em] top-[0.5em] h-[4.75em] rounded-[1em] border border-border bg-muted"
      />
      <span
        data-slot="empty-art-card"
        data-side="end"
        className="absolute inset-x-[1em] top-[0.5em] h-[4.75em] rounded-[1em] border border-border bg-muted"
      />
      <span
        data-slot="empty-art-front"
        className="absolute inset-x-[1em] top-0 flex h-[5em] flex-col justify-between rounded-[1em] border border-dashed border-foreground/25 bg-card p-[0.75em] shadow-[0_0.5em_1.5em_-0.75em_color-mix(in_oklab,var(--foreground)_25%,transparent)]"
      >
        <span
          data-slot="empty-art-tile"
          className={cn(
            "flex size-[1.75em] items-center justify-center rounded-[0.5em] [&_svg]:size-[1em]",
            tone === "error"
              ? "bg-destructive/15 text-destructive"
              : "bg-primary text-primary-foreground",
          )}
        >
          {children}
        </span>
        <span className="flex flex-col gap-[0.375em]">
          <span className="h-[0.375em] w-[3.5em] rounded-full bg-foreground/15" />
          <span className="h-[0.375em] w-[2.25em] rounded-full bg-foreground/8" />
        </span>
      </span>
    </div>
  );
}

export default EmptyArt;
