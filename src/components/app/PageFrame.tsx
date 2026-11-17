"use client";

import type { ReactNode } from "react";
import { cn } from "@/shared/utils";

/**
 * Standard page frame for customer app surfaces.
 * Wraps content in comfortable responsive padding and max-w-7xl / full width.
 */
export function PageFrame({
  children,
  width = "7xl",
  className,
}: {
  children: ReactNode;
  width?: "7xl" | "full";
  className?: string;
}) {
  return (
    <div className="px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8">
      <div
        className={cn(
          "mx-auto animate-page-in space-y-5",
          width === "7xl" && "max-w-7xl",
          className
        )}
      >
        {children}
      </div>
    </div>
  );
}
