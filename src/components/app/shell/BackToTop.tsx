"use client";

import * as React from "react";
import { ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/shared/utils";

/**
 * A round button that springs in once the content pane has scrolled a screen
 * or so, and takes the reader back to the top. It watches the app's scroll
 * pane (#app-content), not the window: the shell scrolls inside that pane.
 */
export function BackToTop({ scrollerId = "app-content", threshold = 640 }: { scrollerId?: string; threshold?: number }) {
  const [shown, setShown] = React.useState(false);

  React.useEffect(() => {
    const scroller = document.getElementById(scrollerId);
    if (!scroller) return;
    const onScroll = () => setShown(scroller.scrollTop > threshold);
    onScroll();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [scrollerId, threshold]);

  return (
    <Button
      size="icon"
      aria-label="Back to top"
      aria-hidden={!shown}
      tabIndex={shown ? 0 : -1}
      onClick={() => {
        const scroller = document.getElementById(scrollerId);
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        scroller?.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
      }}
      className={cn(
        "absolute bottom-5 right-5 z-30 rounded-full shadow-lg transition-[opacity,translate,scale] duration-300 ease-(--ease-spring) motion-reduce:transition-none",
        shown ? "opacity-100" : "pointer-events-none translate-y-4 scale-75 opacity-0",
      )}
    >
      <ArrowUp />
    </Button>
  );
}

export default BackToTop;
