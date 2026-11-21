"use client";

/**
 * One GSAP + Lenis setup for the whole page.
 *
 * Lenis owns the scroll; GSAP's ticker drives Lenis, and every ScrollTrigger
 * updates on Lenis's scroll event, so pinned and scrubbed sections move on the
 * same frame as the page. Under prefers-reduced-motion Lenis is not started
 * and sections render their end state.
 */

import { useEffect, useLayoutEffect, useState } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";
import { Flip } from "gsap/Flip";

let registered = false;
export function registerGsap() {
  if (registered || typeof window === "undefined") return;
  gsap.registerPlugin(ScrollTrigger, SplitText, Flip);
  registered = true;
}

export { gsap, ScrollTrigger, SplitText, Flip };

export const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function prefersReducedMotion() {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** True while `ref` is within `margin` of the viewport. Starts false (SSR-safe). */
export function useInView(ref, margin = "200px") {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const io = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { rootMargin: margin });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, margin]);
  return inView;
}

export function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return reduced;
}

/**
 * Run a GSAP setup function inside a context scoped to `ref`, and revert it
 * (killing tweens, ScrollTriggers and SplitText instances) on unmount.
 */
export function useGsap(ref, setup, deps = []) {
  useIsoLayoutEffect(() => {
    registerGsap();
    if (!ref.current) return undefined;
    const ctx = gsap.context(() => setup({ reduced: prefersReducedMotion() }), ref);
    return () => ctx.revert();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
