'use client';

/**
 * Scroll is traversal.
 *
 * The page has a spine: a length of line down the left edge with a berth for
 * every block. Lenis smooths the scroll, and the marker's position on the
 * line is the reading position — so scrolling reads as a train working down
 * the panel. Sections behind the marker are cleared; the one it occupies is
 * lit; the road ahead is unlit line work.
 *
 * Purely an indicator: it never gates content, and it removes itself under
 * prefers-reduced-motion and on narrow viewports.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLenis } from 'lenis/react';
import { useReducedMotion } from '@/lib/motion';

export function ScrollSpine({ blocks = [] }) {
  const reduced = useReducedMotion();
  const [progress, setProgress] = useState(0);
  const [marks, setMarks] = useState([]);
  const raf = useRef(0);

  /* Where each block sits along the document, as a 0-1 fraction. */
  const measure = useCallback(() => {
    const scrollable = document.documentElement.scrollHeight - window.innerHeight;
    if (scrollable <= 0) {
      setMarks(blocks.map((b) => ({ ...b, at: 0 })));
      return;
    }
    setMarks(
      blocks.map((b) => {
        const el = document.getElementById(b.id);
        const top = el ? el.getBoundingClientRect().top + window.scrollY : 0;
        return { ...b, at: Math.max(0, Math.min(1, top / scrollable)) };
      }),
    );
  }, [blocks]);

  useEffect(() => {
    measure();
    const onResize = () => {
      cancelAnimationFrame(raf.current);
      raf.current = requestAnimationFrame(measure);
    };
    window.addEventListener('resize', onResize);
    /* Content can settle after fonts land. */
    const t = setTimeout(measure, 400);
    return () => {
      window.removeEventListener('resize', onResize);
      clearTimeout(t);
      cancelAnimationFrame(raf.current);
    };
  }, [measure]);

  /* Lenis drives this; the fallback keeps it correct without Lenis. */
  useLenis((lenis) => {
    setProgress(lenis.progress ?? 0);
  });

  useEffect(() => {
    const onScroll = () => {
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      setProgress(scrollable > 0 ? Math.min(1, window.scrollY / scrollable) : 0);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  if (reduced || marks.length === 0) return null;

  /* The block the marker currently occupies. */
  let occupied = 0;
  marks.forEach((m, i) => {
    if (progress >= m.at - 0.02) occupied = i;
  });

  return (
    <nav className="lp-spine" aria-label="Page sections">
      <span className="lp-spine-rail" aria-hidden="true" />
      <span
        className="lp-spine-cleared"
        aria-hidden="true"
        style={{ height: `${progress * 100}%` }}
      />

      {marks.map((m, i) => {
        const state = i < occupied ? 'cleared' : i === occupied ? 'occupied' : 'ahead';
        return (
          <a
            key={m.id}
            href={`#${m.id}`}
            className="lp-spine-berth"
            data-state={state}
            style={{ top: `${m.at * 100}%` }}
          >
            <span className="lp-spine-lamp" aria-hidden="true" />
            <span className="lp-spine-label t-plate">{m.label}</span>
          </a>
        );
      })}

      {/* the marker: a train on the line */}
      <span
        className="lp-spine-train"
        aria-hidden="true"
        style={{ top: `${progress * 100}%` }}
      />
    </nav>
  );
}

export default ScrollSpine;
