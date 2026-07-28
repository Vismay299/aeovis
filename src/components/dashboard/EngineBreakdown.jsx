'use client';

/**
 * Engine approach lines.
 *
 * One line per answer engine, each carrying its own reading and the weight it
 * contributes to the headline. Engines disagree, so this never averages them
 * away — the line work shows each approach separately.
 *
 * (Rebuilt: this panel previously carried hardcoded light-mode Tailwind
 * colours from an earlier design and rendered as a white card inside the dark
 * app.)
 */

import { Lamp } from '@/components/signal/Lamp';
import { TrackCircuit } from '@/components/signal/TrackCircuit';
import { Badge } from '@/components/perceev/Badge';

const ENGINE_CONFIGS = {
  google_ai_overview: { label: 'Google AI Overview', defaultWeight: 0.5 },
  perplexity: { label: 'Perplexity', defaultWeight: 0.25 },
  openai: { label: 'ChatGPT', defaultWeight: 0.15 },
  gemini: { label: 'Gemini', defaultWeight: 0.1 },
};

const lampFor = (score) => (score >= 50 ? 'green' : score >= 20 ? 'amber' : 'red');

export const EngineBreakdown = ({ result }) => {
  const engineScores = result.engineScores || {};
  const costByEngine = result.costByEngine || {};
  const enginesPartial = result.enginesPartial || false;
  const serpCoveragePct = result.serpCoveragePct;

  const displayOrder = ['google_ai_overview', 'perplexity', 'openai', 'gemini'];
  const enginesToShow = Object.keys(engineScores).length
    ? Object.keys(engineScores).sort((a, b) => displayOrder.indexOf(a) - displayOrder.indexOf(b))
    : ['gemini'];

  let totalWeight = 0;
  enginesToShow.forEach((eng) => {
    totalWeight += ENGINE_CONFIGS[eng]?.defaultWeight ?? 0.25;
  });
  if (totalWeight === 0) totalWeight = 1;

  return (
    <div data-testid="engine-breakdown" className="sb-panel">
      <div className="sb-panel__head">
        <span className="t-plate">engine approach lines</span>
        {enginesPartial && (
          <span style={{ marginLeft: 'auto' }}>
            <Badge variant="warn" dot>
              partial output
            </Badge>
          </span>
        )}
      </div>

      <div>
        {enginesToShow.map((eng, i) => {
          const config = ENGINE_CONFIGS[eng] || { label: eng.replace(/_/g, ' '), defaultWeight: 0.25 };
          const score = engineScores[eng] ?? 0;
          const cost = costByEngine[eng] ?? 0;
          const weight = Math.round(((config.defaultWeight ?? 0.25) / totalWeight) * 100);

          return (
            <div
              key={eng}
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(150px, 210px) minmax(0, 1fr) auto',
                alignItems: 'center',
                gap: 'var(--space-4)',
                padding: '14px var(--space-5)',
                borderBottom: i === enginesToShow.length - 1 ? 'none' : '1px solid var(--rule-1)',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
                <Lamp lamp={lampFor(score)} size={8} />
                <span
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: 'var(--text-1)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {config.label}
                </span>
              </span>

              <TrackCircuit
                value={score}
                max={100}
                sections={22}
                lamp="white"
                height={8}
                animate={false}
                label={`${config.label}: ${score.toFixed(1)} per cent`}
              />

              <span style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-4)' }}>
                <span className="t-plate">weight {weight}%</span>
                {cost > 0 && <span className="t-stamp">${cost.toFixed(4)}</span>}
                <span className="t-tally" style={{ fontSize: 16, color: 'var(--text-1)', minWidth: 52, textAlign: 'right' }}>
                  {score.toFixed(1)}%
                </span>
              </span>
            </div>
          );
        })}
      </div>

      <div
        style={{
          borderTop: '1px solid var(--rule-1)',
          padding: '10px var(--space-5)',
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-4)',
          flexWrap: 'wrap',
          background: 'var(--panel-2)',
        }}
      >
        {serpCoveragePct != null && enginesToShow.includes('google_ai_overview') && (
          <span className="t-plate">
            ai overview coverage{' '}
            <span style={{ color: 'var(--text-1)' }}>{serpCoveragePct.toFixed(1)}%</span>
          </span>
        )}
        <span className="t-stamp" style={{ marginLeft: 'auto' }}>
          Headline reading is a weighted blend of these lines.
        </span>
      </div>
    </div>
  );
};

export default EngineBreakdown;
