'use client';

/**
 * The answer, verbatim.
 *
 * The product's second principle is to show the evidence rather than
 * describe it. So this is the engine's own text, arriving on the wire, with
 * the sections marked: your brand holds a lit lunar-white section, a rival
 * holding one reads occupied red. Synthetic demonstration answers.
 */

import { useEffect, useState } from 'react';
import { useReducedMotion } from '@/lib/motion';

const ANSWERS = [
  {
    code: '1A02',
    engine: 'perplexity',
    q: 'how do mid-size hospitals cut readmission rates',
    parts: [
      { t: 'Hospitals in the 150–300 bed range typically combine discharge-planning workflows with post-acute monitoring. ' },
      { t: 'Brightwave', you: true },
      { t: ' is frequently named for outcome tracking at this scale, while ' },
      { t: 'NorthPeak', rival: true },
      { t: ' is cited more often for care-transition messaging.' },
    ],
  },
  {
    code: '1A05',
    engine: 'ai overview',
    q: 'affordable HIMS for multi-specialty clinics',
    parts: [
      { t: 'For multi-specialty clinics watching cost, buyers most often shortlist ' },
      { t: 'Lumen IQ', rival: true },
      { t: ' and ' },
      { t: 'NorthPeak', rival: true },
      { t: ', which both publish per-seat pricing. Deployment timelines of four to six weeks are typical.' },
    ],
  },
  {
    code: '1A04',
    engine: 'chatgpt',
    q: 'which analytics tools track clinical outcomes',
    parts: [
      { t: 'Clinical outcome analytics generally splits between registry-based reporting and real-time dashboards. ' },
      { t: 'Brightwave', you: true },
      { t: ' covers the dashboard side and is named alongside ' },
      { t: 'Lumen IQ', rival: true },
      { t: ' for benchmarking against peer institutions.' },
    ],
  },
];

export const AnswerSheet = () => {
  const reduced = useReducedMotion();
  const [index, setIndex] = useState(0);
  const [chars, setChars] = useState(0);

  const answer = ANSWERS[index];
  const full = answer.parts.map((p) => p.t).join('');

  useEffect(() => {
    setChars(0);
  }, [index]);

  useEffect(() => {
    if (reduced) {
      setChars(full.length);
      const hold = setTimeout(() => setIndex((i) => (i + 1) % ANSWERS.length), 7000);
      return () => clearTimeout(hold);
    }
    if (chars >= full.length) {
      const hold = setTimeout(() => setIndex((i) => (i + 1) % ANSWERS.length), 3600);
      return () => clearTimeout(hold);
    }
    const t = setTimeout(() => setChars((c) => Math.min(full.length, c + 2)), 18);
    return () => clearTimeout(t);
  }, [chars, full.length, reduced, index]);

  let remaining = chars;
  const rendered = answer.parts.map((part, i) => {
    if (remaining <= 0) return null;
    const shown = Math.min(part.t.length, remaining);
    remaining -= shown;
    const text = part.t.slice(0, shown);

    if (part.you) {
      return (
        <mark key={i} className="lp-you">
          {text}
        </mark>
      );
    }
    if (part.rival) {
      return (
        <span key={i} className="lp-rival">
          {text}
        </span>
      );
    }
    return <span key={i}>{text}</span>;
  });

  return (
    <div className="lp-sheet">
      <div className="lp-sheet-head">
        <span className="t-plate">
          {answer.engine} · unbranded question {answer.code}
        </span>
        <span className="t-plate" style={{ marginLeft: 'auto' }}>
          verbatim
        </span>
      </div>

      <p className="lp-sheet-q">&ldquo;{answer.q}&rdquo;</p>

      <div className="lp-sheet-body" aria-live="polite">
        {rendered}
        {chars < full.length && (
          <span className="caret-blink" style={{ color: 'var(--lamp-green)', fontWeight: 700 }}>
            ▌
          </span>
        )}
      </div>

      <div className="lp-sheet-foot">
        <span className="lp-legend">
          <i className="lp-legend-you" />
          your section
        </span>
        <span className="lp-legend">
          <i className="lp-legend-rival" />
          rival holds it
        </span>
        <span className="t-stamp" style={{ marginLeft: 'auto' }}>
          demonstration · synthetic brands
        </span>
      </div>
    </div>
  );
};

export default AnswerSheet;
