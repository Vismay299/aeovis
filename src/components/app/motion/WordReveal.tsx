"use client";

import { Fragment, type ReactNode } from "react";

/**
 * A headline whose words rise into place from behind a mask, the home page's
 * title entrance carried into the app.
 *
 * The home page splits its headlines with GSAP SplitText, which rewrites the
 * DOM under React. App titles change after mount (a brand name arrives, a
 * route re-renders), so here React owns every span: each word is a clipped
 * box and its inner span plays a CSS transform. Text that changes re-keys the
 * spans and plays once more. Anything that is not a plain string renders as
 * given. Reduced motion shows the words in place (motion.css guard).
 */
export function WordReveal({
  text,
  delay = 0,
  step = 42,
}: {
  text: ReactNode;
  /** ms before the first word moves */
  delay?: number;
  /** ms between words */
  step?: number;
}) {
  if (typeof text !== "string" || !text.trim()) return <>{text}</>;
  const words = text.trim().split(/\s+/);
  return (
    <span className="word-reveal" key={text}>
      {words.map((word, i) => (
        <Fragment key={`${i}-${word}`}>
          {i > 0 ? " " : null}
          <span className="word-reveal__w">
            <span
              className="word-reveal__i"
              style={{ animationDelay: `${delay + i * step}ms` }}
            >
              {word}
            </span>
          </span>
        </Fragment>
      ))}
    </span>
  );
}

export default WordReveal;
