'use client';

/**
 * A KPI tile: label, big tabular value, supporting line.
 *
 * `you` is the accent tone, and it is indigo — the same indigo you take in
 * every chart. The semantic tones are for states that genuinely are good,
 * caution or critical.
 */

import { RollingNumber } from '@/components/app/motion/RollingNumber';

const TONE_CLASS = { you: 'is-you' };
const TONE_COLOR = {
  good: 'var(--good)',
  warn: 'var(--warn)',
  crit: 'var(--crit)',
};

export const KpiCard = ({
  label,
  value,
  suffix,
  sub,
  tone = 'neutral',
  testId,
  className = '',
}) => {
  const blank = value == null || (typeof value === 'number' && !Number.isFinite(value));
  const shown = blank ? '—' : value;

  return (
    <div data-testid={testId} className={`stat ${className}`.trim()}>
      <span className="stat__k">{label}</span>
      <span
        className={`stat__v ${TONE_CLASS[tone] || ''}`.trim()}
        style={blank ? { color: 'var(--ink-4)' } : TONE_COLOR[tone] ? { color: TONE_COLOR[tone] } : undefined}
      >
        {blank ? shown : <RollingNumber>{shown}</RollingNumber>}
        {!blank && suffix && <small>{suffix}</small>}
      </span>
      {sub && <span className="stat__d dim">{sub}</span>}
    </div>
  );
};

export default KpiCard;
