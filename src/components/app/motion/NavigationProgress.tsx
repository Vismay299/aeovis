"use client";

import * as React from "react";
import { usePathname, useSearchParams } from "next/navigation";

type Phase = "idle" | "loading" | "done";

function isPlainLeftClick(event: MouseEvent) {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/**
 * A thin bar across the top of the page while a route loads.
 *
 * It starts when an in-app link is clicked and finishes when the URL changes,
 * so a click is answered at once even when the next page takes a moment. A
 * navigation that lands within 120ms never shows it.
 */
function ProgressBar() {
  const pathname = usePathname();
  const search = useSearchParams()?.toString() ?? "";
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [width, setWidth] = React.useState(0);
  const timers = React.useRef<number[]>([]);
  const pending = React.useRef(false);

  const clearTimers = React.useCallback(() => {
    for (const id of timers.current) window.clearTimeout(id);
    timers.current = [];
  }, []);

  const start = React.useCallback(() => {
    clearTimers();
    pending.current = true;
    timers.current.push(
      window.setTimeout(() => {
        if (!pending.current) return;
        setPhase("loading");
        setWidth(12);
        // creep toward the end without ever arriving on its own
        timers.current.push(window.setTimeout(() => setWidth(45), 60));
        timers.current.push(window.setTimeout(() => setWidth(68), 600));
        timers.current.push(window.setTimeout(() => setWidth(82), 1800));
        timers.current.push(window.setTimeout(() => setWidth(90), 4200));
      }, 120),
    );
  }, [clearTimers]);

  React.useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || !isPlainLeftClick(event)) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      let url: URL;
      try {
        url = new URL(anchor.href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      const same = url.pathname === window.location.pathname && url.search === window.location.search;
      if (same) return;
      start();
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [start]);

  // The URL changed: the route has arrived.
  React.useEffect(() => {
    if (!pending.current) return;
    pending.current = false;
    clearTimers();
    setPhase((current) => (current === "loading" ? "done" : "idle"));
    setWidth(100);
    timers.current.push(
      window.setTimeout(() => {
        setPhase("idle");
        setWidth(0);
      }, 360),
    );
  }, [pathname, search, clearTimers]);

  React.useEffect(() => clearTimers, [clearTimers]);

  return (
    <div
      aria-hidden
      data-slot="nav-progress"
      data-phase={phase}
      className="pointer-events-none fixed inset-x-0 top-0 z-[80] h-[2.5px] print:hidden"
      style={{
        opacity: phase === "idle" ? 0 : 1,
        transition: phase === "done" ? "opacity 240ms ease 140ms" : "opacity 120ms ease",
      }}
    >
      <div
        className="relative h-full origin-left overflow-hidden rounded-r-full bg-primary"
        style={{
          width: `${width}%`,
          background: "var(--primary, var(--brand))",
          boxShadow: "0 0 10px color-mix(in oklab, var(--primary, var(--brand)) 60%, transparent)",
          transition:
            phase === "idle"
              ? "none"
              : phase === "done"
                ? "width 200ms cubic-bezier(0.22, 1, 0.36, 1)"
                : "width 900ms cubic-bezier(0.22, 1, 0.36, 1)",
        }}
      >
        <span
          className="absolute inset-0"
          style={{
            background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.55), transparent)",
            animation: phase === "loading" ? "nav-progress-sheen 1.1s ease-in-out infinite" : "none",
          }}
        />
      </div>
    </div>
  );
}

export function NavigationProgress() {
  // useSearchParams needs a Suspense boundary on statically rendered routes.
  return (
    <React.Suspense fallback={null}>
      <ProgressBar />
    </React.Suspense>
  );
}

export default NavigationProgress;
