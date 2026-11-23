"use client";

import { useEffect } from "react";

const CARD_SELECTOR = '[data-slot="card"], [data-slot="stat-tile"], .pv-card';

/**
 * The home page's glowing card edge, for every card in the app.
 *
 * The home page mounts Aceternity's GlowingEffect per card. Each instance
 * listens to the pointer and measures its own box every frame, which is fine
 * for six cards and costly for a workspace page with thirty. This is one
 * delegated listener: it finds the card under the pointer and writes the
 * pointer position to that card alone, once per frame. The light itself is
 * CSS (`data-glow` in landing-app.css), drawn on the card's own pseudo
 * element so nothing else repaints.
 *
 * Touch screens and reduced motion get no glow.
 */
export function CardGlow() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const fine = window.matchMedia("(hover: hover) and (pointer: fine)");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!fine.matches || reduced.matches) return;

    let raf = 0;
    let x = 0;
    let y = 0;
    let target: HTMLElement | null = null;
    let lit: HTMLElement | null = null;

    const clear = () => {
      if (lit) lit.removeAttribute("data-glow");
      lit = null;
    };

    const apply = () => {
      raf = 0;
      if (lit && lit !== target) clear();
      if (!target || !target.isConnected) return;
      const box = target.getBoundingClientRect();
      target.style.setProperty("--glow-x", `${Math.round(x - box.left)}px`);
      target.style.setProperty("--glow-y", `${Math.round(y - box.top)}px`);
      if (lit !== target) {
        target.setAttribute("data-glow", "");
        lit = target;
      }
    };

    const onMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      x = event.clientX;
      y = event.clientY;
      const el = event.target instanceof Element ? event.target : null;
      target = (el?.closest(CARD_SELECTOR) as HTMLElement | null) ?? null;
      if (!raf) raf = requestAnimationFrame(apply);
    };

    const onLeave = () => {
      target = null;
      if (!raf) raf = requestAnimationFrame(apply);
    };

    document.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      clear();
    };
  }, []);

  return null;
}

export default CardGlow;
