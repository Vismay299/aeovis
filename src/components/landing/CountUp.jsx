"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Broadcast count-up — a numeral that counts to its value when it enters
 * the viewport, like a tally board taking new returns. Renders the final
 * value immediately under prefers-reduced-motion, and always for SSR.
 */
export const CountUp = ({ value, duration = 900, delay = 200 }) => {
  const ref = useRef(null);
  const [display, setDisplay] = useState(value);
  const ran = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || ran.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const io = new IntersectionObserver(
      (entries) => {
        if (!entries[0].isIntersecting || ran.current) return;
        ran.current = true;
        io.disconnect();
        const start = performance.now() + delay;
        setDisplay(0);
        const tick = (now) => {
          const t = Math.min(1, Math.max(0, (now - start) / duration));
          // exponential ease-out — decelerating returns
          const eased = 1 - Math.pow(2, -10 * t);
          setDisplay(Math.round(value * (t >= 1 ? 1 : eased)));
          if (t < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      },
      { threshold: 0.4 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [value, duration, delay]);

  return <span ref={ref}>{display}</span>;
};
