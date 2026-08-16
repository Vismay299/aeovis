'use client';

/**
 * Scroll reveal.
 *
 * Reveals are an enhancement, never a gate. The hidden state lives behind a
 * `.js-anim` class on the root, and that class is only added once React has
 * actually run — so if hydration never happens, the server HTML stays fully
 * readable instead of rendering as a blank page.
 *
 * useLayoutEffect, not useEffect: it fires before the browser paints, so the
 * content never flashes in and then hides itself again.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export function Reveal({
  as: Tag = 'div',
  delay = 0,
  className = '',
  style,
  children,
  ...rest
}) {
  const ref = useRef(null);
  const [shown, setShown] = useState(false);

  useIsoLayoutEffect(() => {
    document.documentElement.classList.add('js-anim');
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || shown) return;

    /* No observer support, or motion is unwelcome: settle straight away. */
    if (typeof IntersectionObserver === 'undefined'
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(true);
      return undefined;
    }

    /* Anything already on screen settles without waiting for an observer
       tick. That covers the first viewport, and it covers a pane that is
       not compositing yet — a hidden document never delivers an entry. */
    if (el.getBoundingClientRect().top < window.innerHeight * 0.95) {
      setShown(true);
      return undefined;
    }

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((en) => {
          if (en.isIntersecting) {
            setShown(true);
            io.unobserve(en.target);
          }
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.06 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shown]);

  return (
    <Tag
      ref={ref}
      className={`reveal${shown ? ' is-in' : ''}${className ? ` ${className}` : ''}`}
      style={delay ? { '--d': `${delay}ms`, ...style } : style}
      {...rest}
    >
      {children}
    </Tag>
  );
}

export default Reveal;
