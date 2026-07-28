'use client';

/**
 * Scroll is traversal. On the marketing surfaces the scroll is smoothed so
 * the train reads as travelling down the panel rather than jumping between
 * blocks. The dashboard keeps native scrolling: it is an operator surface
 * with its own internal scroll regions, and smoothing those would fight
 * the task.
 */

import { ReactLenis } from 'lenis/react';
import { useEffect, useState } from 'react';

export default function SmoothScroll({ children }) {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = (e) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  if (reduced) return children;

  return (
    <ReactLenis
      root
      options={{
        lerp: 0.09,
        wheelMultiplier: 0.95,
        smoothWheel: true,
        syncTouch: false,
        /* Never smooth anything that scrolls inside a panel. */
        prevent: (node) => node.hasAttribute?.('data-lenis-prevent'),
      }}
    >
      {children}
    </ReactLenis>
  );
}
