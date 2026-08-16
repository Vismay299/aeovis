'use client';

/**
 * The verdict.
 *
 * Share of AI is the headline metric and this is where it lives: one large
 * tabular number, the delta since the last comparable reading, the per-engine
 * split, and the three figures that produced it.
 *
 * Engine chips render whatever the scan reported — never a fixed set.
 */

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
  const delta = trend != null && trend !== '' ? parseFloat(trend) : null;
  const tierChip = { Strong: 'chip chip--good', Moderate: 'chip chip--warn', Weak: 'chip chip--crit' };

  return (
    <div className="panel" data-testid="score-band">
      <div className="panel__h">
        <b>{scoreLabel || 'Share of AI'}</b>
        {tier && <span className={tierChip[tier] || 'chip'}>{tier}</span>}
        {engineChips && engineChips.length > 0 && (
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8, flexWrap: 'wrap' }}>
            {engineChips.map((chip) => (
              <span key={chip.label} className="chip">
                {chip.label} {chip.value}%
              </span>
            ))}
          </span>
        )}
      </div>

      <div className="panel__b">
        <div
          style={{
            display: 'grid', gridTemplateColumns: 'minmax(0,auto) minmax(0,1fr)',
            gap: 'clamp(20px,3vw,42px)', alignItems: 'center',
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div
              className="num"
              style={{
                fontSize: 'clamp(52px,7vw,84px)', fontWeight: 640, lineHeight: 1,
                letterSpacing: '-.045em', color: 'var(--brand)',
              }}
            >
              {isNumeric ? Math.round(score) : '—'}
              <span style={{ fontSize: '.42em', color: 'var(--ink-3)', marginLeft: 4 }}>%</span>
            </div>
            <div className="tag" style={{ marginTop: 8 }}>of answers name you</div>

            {delta != null && Number.isFinite(delta) && (
              <div
                className={`stat__d ${delta > 0 ? 'up' : delta < 0 ? 'dn' : 'flat'}`}
                style={{ marginTop: 10 }}
              >
                {delta > 0 ? '▲' : delta < 0 ? '▼' : '■'}
                {delta > 0 ? '+' : delta < 0 ? '−' : ''}
                {Math.abs(delta)} since the last reading
              </div>
            )}
          </div>

          <div style={{ display: 'grid', gap: 14, minWidth: 0 }}>
            {promptSetChanged && (
              <span
                className="chip chip--warn"
                data-testid="prompt-set-changed-marker"
                title="The tracked question list changed since the previous scan, so this reading isn't directly comparable to it. The trend restarts here."
                style={{ justifySelf: 'start' }}
              >
                <i className="chip__led" /> Question list changed — trend resets
              </span>
            )}

            {stats.length > 0 && (
              <div
                className="grid"
                style={{ gridTemplateColumns: `repeat(${Math.min(stats.length, 3)}, minmax(0,1fr))` }}
              >
                {stats.map((stat) => (
                  <div key={stat.label} className="stat">
                    <span className="stat__k">{stat.label}</span>
                    <span className="stat__v" style={{ fontSize: 24 }}>{stat.value}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ScoreBand;
