'use client';

/**
 * The instrument bay.
 *
 * The verdict is not a coloured tile with a big number on it — it is the
 * dial the operator trusts, with the aspect the signal is currently showing
 * beside it and the readings that produced it scribed underneath.
 */

import { BlockInstrument } from '@/components/signal/BlockInstrument';
import { AspectSignal, aspectForScore } from '@/components/signal/Lamp';
import { Button } from './Button';

export const HeroScoreCard = ({
  score,
  tierText,
  testId,
  trend,
  stats = [],
  onMethodologyClick,
}) => {
  const isNumeric = typeof score === 'number' && Number.isFinite(score);
  const value = isNumeric ? score : 0;
  const aspect = aspectForScore(isNumeric ? score : null);
  const delta = trend != null && trend !== '' ? parseFloat(trend) : null;

  return (
    <div
      data-testid={testId}
      className="sb-panel"
      style={{ borderTop: `2px solid var(--lamp-${aspect.lamp})` }}
    >
      <div className="sb-panel__head">
        <span className="t-plate">share of ai answers</span>
        {tierText && (
          <span className="t-plate" style={{ marginLeft: 'auto', color: `var(--lamp-${aspect.lamp})` }}>
            {tierText}
          </span>
        )}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(190px, 260px) minmax(0, 1fr)',
          gap: 'var(--space-7)',
          padding: 'var(--space-6) var(--space-5)',
          alignItems: 'center',
        }}
      >
        <BlockInstrument
          value={value}
          size={240}
          caption="of answers reach you"
          showAspect={false}
        />

        <div style={{ display: 'grid', gap: 'var(--space-5)', minWidth: 0 }}>
          <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
            <span className="t-plate">aspect displayed</span>
            <AspectSignal aspect={aspect} size="md" />
          </div>

          {delta != null && Number.isFinite(delta) && (
            <div style={{ display: 'grid', gap: 5 }}>
              <span className="t-plate">since last reading</span>
              <span
                className="t-tally"
                style={{
                  fontSize: 19,
                  color: delta > 0 ? 'var(--lamp-green)' : delta < 0 ? 'var(--lamp-red)' : 'var(--text-2)',
                }}
              >
                {delta > 0 ? '+' : delta < 0 ? '−' : ''}
                {Math.abs(delta)}
                <span style={{ fontSize: 12, color: 'var(--text-3)' }}> pts</span>
              </span>
            </div>
          )}

          {stats.length > 0 && (
            <ul
              style={{
                display: 'grid',
                gap: 7,
                margin: 0,
                padding: 0,
                listStyle: 'none',
                borderTop: '1px solid var(--rule-1)',
                paddingTop: 'var(--space-4)',
              }}
            >
              {stats.map((stat, i) => (
                <li
                  key={i}
                  style={{ font: 'var(--type-body-sm)', color: 'var(--text-2)', lineHeight: 1.5 }}
                >
                  {stat}
                </li>
              ))}
            </ul>
          )}

          {onMethodologyClick && (
            <Button variant="ghost" size="sm" onClick={onMethodologyClick} style={{ justifySelf: 'start' }}>
              how this is measured
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

export default HeroScoreCard;
