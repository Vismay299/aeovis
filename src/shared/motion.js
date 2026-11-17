'use client';

/**
 * Motion material for The Signal Box.
 *
 * The world's native motion is a filament and a relay: lamps ramp up
 * with an inrush overshoot and decay on a slow tail, and a route
 * illuminates section by section so causality is visible. Nothing here
 * fades. See DESIGN.md § Motion.
 */

import { useEffect, useRef, useState } from 'react';

/* Easings as cubic-bezier arrays for framer-motion, mirroring the CSS
   custom properties of the same name in globals.css. */
export const EASE_LAMP = [0.2, 0.9, 0.1, 1];
export const EASE_DECAY = [0.4, 0, 0.7, 0.2];
export const EASE_POINT = [0.34, 1.3, 0.5, 1];
export const EASE_OUT = [0.22, 1, 0.36, 1];

export const DUR_LAMP = 0.14;
export const DUR_DECAY = 0.26;
export const DUR_POINT = 0.38;

/** Seconds between adjacent sections lighting along a route. */
export const CHAIN_STEP = 0.055;

/** A lamp coming up: visible by default, so this only ever enhances. */
export const lampIn = (delay = 0) => ({
  initial: { opacity: 0, filter: 'brightness(0.35)' },
  animate: { opacity: 1, filter: 'brightness(1)' },
  transition: { duration: DUR_LAMP, ease: EASE_LAMP, delay },
});

/** Route travel: section i lights CHAIN_STEP after section i-1. */
export const chainDelay = (i, base = 0) => base + i * CHAIN_STEP;

export function useReducedMotion() {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = (e) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

/**
 * Fires once when the element enters the viewport. Used to arm a route
 * chain as the train reaches that block — not to fade content in.
 */
export function useEnteredBlock({ threshold = 0.25, rootMargin = '0px 0px -12% 0px' } = {}) {
  const ref = useRef(null);
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') {
      setEntered(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setEntered(true);
          io.disconnect();
        }
      },
      { threshold, rootMargin },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [threshold, rootMargin]);

  return [ref, entered];
}

/**
 * Lights `count` sections in sequence once `armed` is true, returning how
 * many are currently lit. Under reduced motion every section is lit at
 * once — the state stays readable, only the travel is dropped.
 */
export function useRouteChain(count, armed, { step = CHAIN_STEP * 1000, startDelay = 0 } = {}) {
  const reduced = useReducedMotion();
  const [lit, setLit] = useState(0);

  useEffect(() => {
    if (!armed || count <= 0) {
      setLit(0);
      return;
    }
    if (reduced) {
      setLit(count);
      return;
    }

    let n = 0;
    let interval;
    const kickoff = setTimeout(() => {
      interval = setInterval(() => {
        n += 1;
        setLit(n);
        if (n >= count) clearInterval(interval);
      }, step);
    }, startDelay);

    return () => {
      clearTimeout(kickoff);
      if (interval) clearInterval(interval);
    };
  }, [armed, count, reduced, step, startDelay]);

  return lit;
}

/**
 * Counts a tally up to `value` on a lamp ramp. Tallies are read, so the
 * final value is always reached and never animates on every re-render.
 */
export function useTally(value, armed = true, duration = 900) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(0);
  const from = useRef(0);

  useEffect(() => {
    if (!armed) return;
    if (reduced || !Number.isFinite(value)) {
      setShown(value);
      from.current = value;
      return;
    }

    const start = performance.now();
    const a = from.current;
    const b = value;
    let raf;

    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      /* exponential ease-out — the needle settling, not a linear sweep */
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(a + (b - a) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
      else from.current = b;
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, armed, reduced, duration]);

  return shown;
}
