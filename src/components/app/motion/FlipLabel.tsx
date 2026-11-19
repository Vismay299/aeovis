"use client";

import type { ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "@/shared/utils";

/**
 * The label half of the locked labelled progress
 * (`watermelon/labeled-progress-indicator.tsx`): when the stage changes, the
 * old label tips away and the new one flips up into place.
 *
 * The vendored indicator cycles its labels on a timer. This one never moves
 * on its own: it changes only when `labelKey` does, and the caller passes the
 * real stage (e.g. the scan's stage label from scanTrackerModel.js). The first
 * label renders in place, and reduced motion swaps the words without moving.
 */
export function FlipLabel({
  labelKey,
  children,
  className,
}: {
  /** Changes exactly when the real stage changes. */
  labelKey: string;
  children: ReactNode;
  className?: string;
}) {
  const reduce = useReducedMotion();
  if (reduce) return <span className={className}>{children}</span>;

  return (
    <span className={cn("relative inline-flex perspective-[800px]", className)}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={labelKey}
          initial={{ opacity: 0, y: 10, scale: 1.4, filter: "blur(4px)", rotateX: -60 }}
          animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)", rotateX: 0 }}
          exit={{ opacity: 0, filter: "blur(4px)", rotateX: 90, scale: 0.9 }}
          transition={{ type: "spring", stiffness: 600, damping: 100, mass: 10 }}
          className="inline-block origin-bottom transform-3d"
        >
          {children}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

export default FlipLabel;
