'use client';

/**
 * The instrument bay at the head of the panel.
 *
 * The reading is a dial with an engraved scale and the aspect the signal is
 * currently showing, not a large coloured numeral with a glow behind it. The
 * figures that produced it are scribed alongside.
 */

import { BlockInstrument } from '@/components/signal/BlockInstrument';
import { AspectSignal, aspectForTier, Lamp } from '@/components/signal/Lamp';
import { Badge } from '@/components/perceev/Badge';

export const ScoreBand = ({
  score,
  tier,
  trend,
  stats = [],
  engineChips,
  scoreLabel,
  promptSetChanged,
}) => {
  const isNumeric = typeof score === 'number' && Number.isFinite(score);
  const aspect = aspectForTier(tier);
  const delta = trend != null && trend !== '' ? parseFloat(trend) : null;

  return (
    <div className="sb-panel" style={{ borderTop: `2px solid var(--lamp-${aspect.lamp})` }}>
      <div className="sb-panel__head">
        <span className="t-plate">{scoreLabel || 'share of ai answers'}</span>
        {engineChips && engineChips.length > 0 && (
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 14, flexWrap: 'wrap' }}>
            {engineChips.map((chip, i) => (
              <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Lamp lamp={chip.value > 0 ? 'green' : 'red'} size={6} />
                <span className="t-plate">
                  {chip.label} {chip.value}%
                </span>
              </span>
            ))}
          </span>
        )}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(150px, 176px) minmax(0, 1fr)',
          gap: 'var(--space-7)',
          padding: 'var(--space-5)',
          alignItems: 'center',
        }}
      >
        <BlockInstrument
          value={isNumeric ? score : 0}
          size={168}
          caption="of answers reach you"
          showAspect={false}
        />

        <div style={{ display: 'grid', gap: 'var(--space-4)', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
            <AspectSignal aspect={aspect} size="sm" />
            {tier && <Badge variant={tier}>{tier}</Badge>}
            {delta != null && Number.isFinite(delta) && (
              <span
                className="t-tally"
                style={{
                  fontSize: 14,
                  color:
                    delta > 0 ? 'var(--lamp-green-text)' : delta < 0 ? 'var(--lamp-red-text)' : 'var(--text-2)',
                }}
              >
                {delta > 0 ? '+' : delta < 0 ? '−' : ''}
                {Math.abs(delta)} since last
              </span>
            )}
          </div>

          {promptSetChanged && (
            <span
              data-testid="prompt-set-changed-marker"
              title="The tracked question list changed since the previous scan, so this reading isn't directly comparable to it. The trend restarts here."
              style={{
                justifySelf: 'start',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                padding: '3px 8px',
                borderRadius: 1,
                background: 'var(--lamp-amber-soft)',
                border: '1px solid var(--lamp-amber-edge)',
              }}
            >
              <Lamp lamp="amber" size={6} />
              <span className="t-plate" style={{ color: 'var(--lamp-amber-text)' }}>
                question list changed — trend resets
              </span>
            </span>
          )}

          {stats.length > 0 && (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: `repeat(${Math.min(stats.length, 4)}, minmax(0, 1fr))`,
                gap: '1px',
                background: 'var(--rule-1)',
                border: '1px solid var(--rule-1)',
                borderRadius: 1,
              }}
            >
              {stats.map((stat, i) => (
                <div
                  key={i}
                  style={{
                    background: 'var(--panel-1)',
                    padding: '9px 12px',
                    display: 'grid',
                    gap: 4,
                    minWidth: 0,
                  }}
                >
                  <span className="t-tally" style={{ fontSize: 17, color: 'var(--text-1)' }}>
                    {stat.value}
                  </span>
                  <span className="t-plate" style={{ whiteSpace: 'normal', lineHeight: 1.35 }}>
                    {stat.label}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ScoreBand;
