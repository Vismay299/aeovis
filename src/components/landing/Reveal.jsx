'use client';

/**
 * Blocks light as the train enters them.
 *
 * Content is visible by default and this only lifts it the last few pixels —
 * the page is readable whether or not the lamps ever fire. CSS handles
 * prefers-reduced-motion.
 */

import { useEffect, useRef } from 'react';

export const Reveal = ({ children, delay = 0, className = '' }) => {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          el.classList.add('is-lit');
          io.disconnect();
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -48px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`lp-block ${className}`}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
};

export default Reveal;
