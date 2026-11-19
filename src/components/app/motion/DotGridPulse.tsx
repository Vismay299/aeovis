"use client";

import * as React from "react";
import { animate, stagger } from "animejs";
import { cn } from "@/shared/utils";

/**
 * A grid of dots that pulses outward from its centre, over and over: the
 * visual for "a scan is running". Driven by anime.js, whose grid stagger
 * delays each dot by its distance from the origin.
 */
export function DotGridPulse({
  columns = 15,
  rows = 7,
  className,
}: {
  columns?: number;
  rows?: number;
  className?: string;
}) {
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const root = ref.current;
    if (!root) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const animation = animate(root.querySelectorAll("[data-dot]"), {
      scale: [1, 2.4, 1],
      opacity: [0.22, 1, 0.22],
      duration: 900,
      delay: stagger(70, { grid: [columns, rows], from: "center" }),
      ease: "inOutSine",
      loop: true,
      loopDelay: 500,
    });
    return () => {
      animation.revert();
    };
  }, [columns, rows]);

  return (
    <div
      ref={ref}
      aria-hidden
      data-slot="dot-grid"
      className={cn("grid place-items-center gap-y-3", className)}
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {Array.from({ length: columns * rows }, (_, index) => (
        <span key={index} data-dot className="size-1 rounded-full bg-primary opacity-20" />
      ))}
    </div>
  );
}

export default DotGridPulse;
