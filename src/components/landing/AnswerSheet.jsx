'use client';

/**
 * The hero answer sheet.
 *
 * The product's characteristic act: an engine answer arriving verbatim and
 * being marked up as it lands. A brand name only lights once it has been
 * completely written, so the mark reads as a verdict rather than a highlight.
 */

import { useEffect, useRef, useState } from 'react';

import { primaryDeployedEngineLabel } from '@/lib/engines/deployedEngines';

/* R2.10.5 — this chip was the string 'Perplexity', typed. Rebuilt under
   NEXT_PUBLIC_ENGINES=aio the hero sentence and the engine rail both narrowed
   to Google AI Overview and the served HTML still carried exactly one
   Perplexity: this chip, attributing a sample answer to an engine that
   deployment does not probe. The sheet shows one answer, so it names one
   engine, and it is the deployment's own. Read at module scope, from the
   inlined NEXT_PUBLIC_ literal, so SSR and the browser cannot disagree. */
const SHEET_ENGINE = primaryDeployedEngineLabel();

/* One segment per run of text. `mark` is the verdict the segment carries. */
const SHEET = [
  { t: 'Clinical outcome analytics generally splits between registry-based reporting and real-time dashboards. ' },
  { t: 'Brightwave', mark: 'you' },
  { t: ' covers the dashboard side well for mid-size hospitals and is frequently named for readmission tracking. For registry submission and NABH-aligned reporting, ' },
  { t: 'NorthPeak', mark: 'rival' },
  { t: ' is cited more often, particularly by Indian implementation partners.' },
];

const FULL = SHEET.map((s) => s.t.length);
const TOTAL = FULL.reduce((a, b) => a + b, 0);

export function AnswerSheet() {
  /* Written character count across the whole passage. One number drives both
     which segment is being typed and how much of it exists. */
  const [written, setWritten] = useState(0);
  const [instant, setInstant] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setInstant(true);
      return undefined;
    }

    let n = 0;
    const step = () => {
      n += 1;
      setWritten(n);
      if (n >= TOTAL) return;
      /* a brand name is typed slower, and the passage pauses on finishing one */
      let seg = 0;
      let acc = 0;
      while (seg < FULL.length - 1 && acc + FULL[seg] < n) { acc += FULL[seg]; seg += 1; }
      const inMark = Boolean(SHEET[seg].mark);
      const justFinished = acc + FULL[seg] === n;
      timer.current = setTimeout(step, justFinished ? (inMark ? 260 : 40) : (inMark ? 34 : 11));
    };
    timer.current = setTimeout(step, 700);
    return () => clearTimeout(timer.current);
  }, []);

  const done = instant || written >= TOTAL;
  let cursor = 0;

  return (
    <div className="sheet">
      <div className="sheet__top">
        <span className="chip">{SHEET_ENGINE}</span>
        <span className="tag">Unbranded question 04</span>
        {/* R2.10.1 — this sheet types out a hardcoded script (SHEET above). It
            was labelled "Live" with a status LED, the strongest claim the design
            system can make and the one thing this content cannot support. It is
            an illustration, and now says so. */}
        <span className="chip" style={{ marginLeft: 'auto' }}>
          Sample answer
        </span>
      </div>
      <div className="sheet__body">
        <p className="sheet__q">&ldquo;which analytics tools track clinical outcomes&rdquo;</p>
        <p className="sheet__a">
          {SHEET.map((s, i) => {
            const start = cursor;
            cursor += s.t.length;
            const shown = instant ? s.t : s.t.slice(0, Math.max(0, Math.min(s.t.length, written - start)));
            if (!shown) return null;
            /* the mark only lights once the whole name is on the page */
            const lit = instant || written >= cursor;
            if (!s.mark) return <span key={i}>{shown}</span>;
            return (
              <mark key={i} className={lit ? `lit-${s.mark}` : undefined}>{shown}</mark>
            );
          })}
          {!done && <span className="caret" />}
        </p>
        <div className="sheet__foot">
          <span className="chip chip--you">You · mentioned</span>
          <span className="chip">Rival cited first</span>
          <span className="chip">4 sources</span>
        </div>
      </div>
    </div>
  );
}

export default AnswerSheet;
