'use client';

/**
 * Scroll is traversal.
 *
 * Lenis smooths the wheel; this reads the resulting progress and fills the
 * length of line the reader has travelled, with a marker riding the head of
 * it. Indicator only — it never gates content and it removes itself under
 * prefers-reduced-motion.
 */

import { useEffect, useRef, useState } from 'react';
import { useLenis } from 'lenis/react';
import { useReducedMotion } from '@/lib/motion';

export function LineTraversal() {
  const reduced = useReducedMotion();
  const [pct, setPct] = useState(0);
  const ref = useRef(null);

  /* Progress of the reader through this column, not the whole document, so
     the marker lines up with the blocks it is passing. */
  const compute = () => {
    const el = ref.current?.parentElement;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const travelled = window.innerHeight * 0.5 - rect.top;
    setPct(Math.max(0, Math.min(1, travelled / rect.height)));
  };

  useLenis(() => compute());

  useEffect(() => {
    compute();
    window.addEventListener('scroll', compute, { passive: true });
    window.addEventListener('resize', compute);
    return () => {
      window.removeEventListener('scroll', compute);
      window.removeEventListener('resize', compute);
    };
  }, []);

  if (reduced) return <span ref={ref} hidden />;

  return (
    <>
      <span ref={ref} className="lp-line-travelled" style={{ height: `${pct * 100}%` }} aria-hidden="true" />
      <span className="lp-line-marker" style={{ top: `${pct * 100}%` }} aria-hidden="true" />
    </>
  );
}

export default LineTraversal;
