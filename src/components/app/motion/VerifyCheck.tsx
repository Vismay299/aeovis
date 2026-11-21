"use client";

import * as React from "react";
import { cn } from "@/shared/utils";

export type VerifyState = "idle" | "checking" | "verified";

/**
 * A "confirm you are human" style control: a box that turns into a spinner
 * while it checks, then fills and draws its tick. The parent owns the state
 * and decides how long checking takes.
 */
export function VerifyCheck({
  state,
  onVerify,
  label = "I am not a robot",
  className,
}: {
  state: VerifyState;
  onVerify: () => void;
  label?: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === "verified"}
      aria-busy={state === "checking" || undefined}
      data-slot="verify"
      data-state={state}
      disabled={state !== "idle"}
      onClick={onVerify}
      className={cn(
        "group/verify flex w-full max-w-xs items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left text-sm font-medium text-foreground shadow-xs outline-none transition-[border-color,box-shadow] duration-200 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 enabled:hover:border-foreground/30 disabled:cursor-default",
        className,
      )}
    >
      <span
        data-slot="verify-box"
        className="relative grid size-7 shrink-0 place-items-center rounded-md border-2 border-input"
      >
        <span data-slot="verify-burst" />
        <svg viewBox="0 0 28 28" fill="none" aria-hidden className="absolute -inset-0.5 size-[calc(100%+4px)]">
          {state === "checking" ? (
            <g data-slot="spinner" style={{ transformOrigin: "14px 14px" }}>
              <circle cx="14" cy="14" r="11.5" stroke="currentColor" strokeOpacity="0.18" strokeWidth="2.5" />
              <circle
                data-arc
                cx="14"
                cy="14"
                r="11.5"
                pathLength={150}
                stroke="var(--primary)"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeDasharray="90 150"
              />
            </g>
          ) : null}
          <path
            data-slot="verify-tick"
            pathLength={1}
            d="M8.2 14.6l3.9 3.9 7.9-8.6"
            stroke="var(--success-foreground, #fff)"
            strokeWidth="2.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span className="grid">
        <span className={cn("col-start-1 row-start-1 transition-[opacity,translate] duration-300", state === "idle" ? "opacity-100" : "-translate-y-1 opacity-0")}>
          {label}
        </span>
        <span className={cn("col-start-1 row-start-1 text-muted-foreground transition-[opacity,translate] duration-300", state === "checking" ? "opacity-100" : "translate-y-1 opacity-0")}>
          Checking…
        </span>
        <span className={cn("col-start-1 row-start-1 text-success transition-[opacity,translate] duration-300 delay-100", state === "verified" ? "opacity-100" : "translate-y-1 opacity-0")}>
          Verified
        </span>
      </span>
    </button>
  );
}

export default VerifyCheck;
