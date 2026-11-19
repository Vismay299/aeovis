"use client";

import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import {
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Info,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/shared/utils";

/**
 * T8 — the locked inline alert (Kokonut "Inline Alert",
 * `src/components/kokonutui/inline-alert.tsx`), made honest.
 *
 * The vendored alert's retry flips failed checks to passed on a timer. This
 * one never decides a result: Retry calls the caller's real refetch, the alert
 * shows it is waiting while that request is in flight, and whatever the
 * caller renders next is the result. A check is only ever drawn as passed when
 * the caller says it passed.
 *
 * Look and motion kept from the original: a tinted surface whose passed share
 * wipes in from the left, a round tone badge that swaps to a spinner while
 * checking, the title steps in when it changes, and a collapsible list of
 * checks with a drawn tick for each pass.
 */

export type InlineAlertTone = "error" | "warning" | "info" | "success";

export type InlineAlertCheck = {
  /** What was checked, e.g. "robots.txt". */
  name: string;
  /**
   * true passed, false failed, null neither — not known, or not a pass/fail
   * matter. Only true is ever drawn as a pass.
   */
  ok: boolean | null;
  /** The observed result in words, e.g. "Found", "Missing", "Couldn't read". */
  status: string;
  detail?: ReactNode;
};

const TONE_SURFACE: Record<InlineAlertTone, string> = {
  error: "border-destructive/30 bg-destructive/10",
  warning: "border-warning/40 bg-warning/12",
  info: "border-info/30 bg-info/10",
  success: "border-success/30 bg-success/10",
};

const TONE_BADGE: Record<InlineAlertTone, string> = {
  error: "bg-destructive text-background",
  warning: "bg-warning text-background",
  info: "bg-info text-background",
  success: "bg-success text-background",
};

const TONE_ICON = {
  error: CircleAlert,
  warning: TriangleAlert,
  info: Info,
  success: CircleCheck,
} as const;

type DivProps = Omit<ComponentProps<"div">, "title" | "children">;

export function InlineAlert({
  tone = "error",
  title,
  message,
  checks,
  onRetry,
  retrying,
  retryLabel = "Try again",
  action,
  onDismiss,
  icon,
  className,
  ...rest
}: DivProps & {
  tone?: InlineAlertTone;
  title: ReactNode;
  message?: ReactNode;
  checks?: InlineAlertCheck[];
  /** The real refetch. If it returns a promise, the alert waits on it. */
  onRetry?: () => unknown;
  /** The caller's in-flight flag (e.g. `isFetching`); wins over the alert's own. */
  retrying?: boolean;
  retryLabel?: string;
  /** Another action shown beside Retry, or instead of it. */
  action?: ReactNode;
  onDismiss?: () => void;
  /** Replaces the tone's icon in the badge. */
  icon?: LucideIcon;
}) {
  const [waiting, setWaiting] = useState(false);
  const [open, setOpen] = useState(true);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const busy = retrying ?? waiting;

  const retry = () => {
    if (!onRetry || busy) return;
    const result = onRetry();
    if (result && typeof (result as Promise<unknown>).then === "function") {
      setWaiting(true);
      (result as Promise<unknown>)
        .catch(() => undefined)
        .finally(() => {
          if (mounted.current) setWaiting(false);
        });
    }
  };

  const list = checks ?? [];
  const passed = list.filter((check) => check.ok === true).length;
  // The passed share wipes in from the left: only what the caller reports.
  const passedShare = list.length ? passed / list.length : tone === "success" ? 1 : 0;
  const Icon = icon ?? TONE_ICON[tone];
  const hasChecks = list.length > 0;

  return (
    <div
      data-slot="inline-alert"
      data-tone={tone}
      data-busy={busy || undefined}
      role={tone === "error" ? "alert" : "status"}
      aria-busy={busy || undefined}
      className={cn("relative w-full overflow-hidden rounded-2xl text-foreground", className)}
      {...rest}
    >
      <div aria-hidden className={cn("absolute inset-0 rounded-2xl border", TONE_SURFACE[tone])} />
      {tone !== "success" && hasChecks ? (
        <div
          aria-hidden
          data-slot="inline-alert-wipe"
          className="absolute inset-0 rounded-2xl border border-success/30 bg-success/10"
          style={{ clipPath: `inset(0% ${(1 - passedShare) * 100}% 0% 0%)` }}
        />
      ) : null}

      <div className="relative flex gap-3 p-4">
        <span
          className={cn(
            "relative flex size-7 shrink-0 items-center justify-center rounded-full transition-colors duration-300",
            busy ? "bg-foreground/15 text-foreground" : TONE_BADGE[tone],
          )}
        >
          {/* Keyed so the glyph pops in again whenever it changes. */}
          <span key={busy ? "busy" : tone} data-slot="inline-alert-swap" className="flex">
            {busy ? <Spinner aria-hidden className="size-4" /> : <Icon aria-hidden className="size-4" />}
          </span>
        </span>

        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex items-start justify-between gap-3">
            <div aria-live="polite" className="min-w-0">
              <div data-slot="inline-alert-title" className="text-sm font-semibold leading-5">
                {title}
              </div>
              {message ? (
                <div className="mt-0.5 text-[13px] text-muted-foreground [&_a]:underline [&_a]:underline-offset-3">
                  {message}
                </div>
              ) : null}
            </div>
            {onDismiss ? (
              <button
                type="button"
                aria-label="Dismiss"
                onClick={onDismiss}
                className="-mt-1 -mr-1 flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <X aria-hidden className="size-4" />
              </button>
            ) : null}
          </div>

          {hasChecks ? (
            <div
              data-slot="inline-alert-checks"
              data-open={open || undefined}
              aria-hidden={!open || undefined}
              inert={!open || undefined}
              className="grid"
            >
              <ul className="min-h-0 overflow-hidden">
                {list.map((check) => (
                  <CheckRow key={check.name} check={check} checking={busy && check.ok !== true} />
                ))}
              </ul>
            </div>
          ) : null}

          {onRetry || action || hasChecks ? (
            <div className="flex flex-wrap items-center gap-2 pt-3">
              {onRetry ? (
                <Button size="sm" pending={busy} onClick={retry}>
                  {retryLabel}
                </Button>
              ) : null}
              {action}
              {hasChecks ? (
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setOpen((value) => !value)}
                  className="inline-flex h-7 items-center gap-1.5 rounded-full bg-foreground/8 px-3 text-[0.8rem] font-medium outline-none transition-colors hover:bg-foreground/12 focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  {open ? "Hide checks" : "Show checks"}
                  <ChevronDown
                    aria-hidden
                    className={cn("size-3.5 transition-transform duration-200", open && "rotate-180")}
                  />
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function CheckRow({ check, checking }: { check: InlineAlertCheck; checking: boolean }) {
  const state = checking ? "checking" : check.ok === true ? "passed" : check.ok === false ? "failed" : "unknown";
  return (
    <li className="flex items-start gap-2.5 pt-2.5 first:pt-3">
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
        <span key={state} data-slot="inline-alert-swap" className="flex">
          <CheckGlyph state={state} />
        </span>
      </span>
      <span className="min-w-0 flex-1 text-[13px]">
        <span className="flex items-center justify-between gap-2">
          <span className="font-medium">{check.name}</span>
          <span className="text-xs text-muted-foreground">{checking ? "Checking" : check.status}</span>
        </span>
        {check.detail ? (
          <span
            className={cn(
              "block text-xs text-muted-foreground transition-opacity duration-200",
              checking && "opacity-50",
            )}
          >
            {check.detail}
          </span>
        ) : null}
      </span>
    </li>
  );
}

function CheckGlyph({ state }: { state: "checking" | "passed" | "failed" | "unknown" }) {
  if (state === "checking") return <Spinner aria-hidden className="size-4 text-info" />;
  if (state === "passed") {
    return (
      <svg aria-hidden data-slot="inline-alert-tick" className="size-4 text-success" fill="none" viewBox="0 0 16 16">
        <circle cx={8} cy={8} r={8} fill="currentColor" opacity={0.15} />
        <path
          d="M5 8.2l2 2 4-4.2"
          pathLength={1}
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.8}
        />
      </svg>
    );
  }
  if (state === "failed") {
    return (
      <svg aria-hidden className="size-4 text-destructive" fill="none" viewBox="0 0 16 16">
        <circle cx={8} cy={8} r={8} fill="currentColor" opacity={0.15} />
        <path
          d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth={1.8}
        />
      </svg>
    );
  }
  // Not known: a dash, never a tick.
  return (
    <svg aria-hidden className="size-4 text-muted-foreground" fill="none" viewBox="0 0 16 16">
      <circle cx={8} cy={8} r={8} fill="currentColor" opacity={0.15} />
      <path d="M5.5 8h5" stroke="currentColor" strokeLinecap="round" strokeWidth={1.8} />
    </svg>
  );
}

export default InlineAlert;
