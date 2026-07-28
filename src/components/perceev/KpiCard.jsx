'use client';

/**
 * An instrument readout.
 *
 * Not a metric card. A readout is a cell in a strip of instruments along a
 * panel: engraved plate, recessed value window, and a state lamp when the
 * value carries one. Meant to sit inside a ReadoutStrip so a row of them
 * reads as one instrument bank divided by scribed rules — never as four
 * floating cards.
 */

import { Lamp } from '@/components/signal/Lamp';

const TONE_LAMP = { neutral: null, good: 'green', warn: 'amber', crit: 'red', you: 'white' };
const TONE_COLOR = {
  neutral: 'var(--text-1)',
  good: 'var(--lamp-green)',
  warn: 'var(--lamp-amber)',
  crit: 'var(--lamp-red)',
  you: 'var(--lamp-white)',
};

export const KpiCard = ({ label, value, suffix, sub, tone = 'neutral', testId, className = '' }) => {
  const lamp = TONE_LAMP[tone];
  const color = TONE_COLOR[tone] || TONE_COLOR.neutral;
  const blank = value == null || (typeof value === 'number' && !Number.isFinite(value));
  const shown = blank ? '—' : value;

  return (
    <div
      data-testid={testId}
      className={className}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
        padding: 'var(--space-4) var(--space-5)',
        minWidth: 0,
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
        {lamp && <Lamp lamp={lamp} size={7} />}
        <span className="t-plate">{label}</span>
      </span>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
        <span
          className="t-tally"
          style={{ fontSize: 32, lineHeight: 1, color: blank ? 'var(--text-3)' : color }}
        >
          {shown}
        </span>
        {suffix && !blank && (
          <span className="t-tally" style={{ fontSize: 14, color: 'var(--text-3)' }}>
            {suffix}
          </span>
        )}
      </div>

      {sub && (
        <span style={{ font: 'var(--type-body-sm)', color: 'var(--text-3)', lineHeight: 1.45 }}>
          {sub}
        </span>
      )}
    </div>
  );
};

export default KpiCard;
