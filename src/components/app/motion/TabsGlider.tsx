"use client";

import * as React from "react";

/**
 * The continuous-tabs pill (`watermelon/continuous-tabs.tsx`) for a plain
 * button tab list: one pill that glides to whichever tab is selected, instead
 * of the highlight jumping between buttons.
 *
 * Drop it inside the tablist. It measures the `[aria-selected="true"]` tab of
 * its parent and moves there (motion.css, `[data-slot="tabs-glider"]`). Until
 * it has measured — on the server and during hydration — it renders nothing
 * visible and the tab keeps its own highlight, so the selected tab is always
 * marked. Selection, roles and keyboard stay with the tab list itself.
 */
export function TabsGlider({ activeKey }: { activeKey: string | number | null | undefined }) {
  const ref = React.useRef<HTMLSpanElement>(null);

  React.useLayoutEffect(() => {
    const glider = ref.current;
    const list = glider?.parentElement;
    if (!glider || !list) return;

    let frame = 0;
    const place = () => {
      const active = list.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!active) {
        list.removeAttribute("data-glide");
        return;
      }
      glider.style.setProperty("--glider-left", `${active.offsetLeft}px`);
      glider.style.setProperty("--glider-top", `${active.offsetTop}px`);
      glider.style.setProperty("--glider-width", `${active.offsetWidth}px`);
      glider.style.setProperty("--glider-height", `${active.offsetHeight}px`);
      // The list hands the highlight to the pill a frame after it is first
      // placed, so the pill appears in position instead of sliding in.
      if (!list.hasAttribute("data-glide")) {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => list.setAttribute("data-glide", ""));
      }
    };

    place();
    const observer = new ResizeObserver(place);
    observer.observe(list);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [activeKey]);

  return <span ref={ref} aria-hidden data-slot="tabs-glider" />;
}

export default TabsGlider;
