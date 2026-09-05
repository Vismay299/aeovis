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

/**
 * States that mean "this engine was measured normally", and therefore need no
 * marker on the chip. Anything else a producer sends is printed as it arrived:
 * a vocabulary this build does not recognise must reach the screen, not be
 * swallowed for being unfamiliar.
 */
const MEASURED_STATES = new Set(['ok', 'measured', 'complete', 'healthy', 'probed']);

/**
 * How one engine chip reads. R2.7.8.
 *
 * This was `{chip.label} {chip.value}%` — an UNCONDITIONAL percent sign, so a
 * chip could only ever carry a number. An engine that was frozen into the scan
 * and never probed has no number to carry, so it either rendered as the
 * nonsense "Perplexity —%" or, in practice, was left out of the row entirely:
 * the headline surface listed the engines that answered and said nothing about
 * the ones that did not. Standing rule 5 — an absent measurement is an em dash
 * plus a state chip, never a 0 and never a silent omission.
 *
 * The accepted shape is deliberately loose. `state` and `stateReason` are
 * OPTIONAL, because per-engine state is being added to the pipeline separately
 * (R2.1.1) and this has to render honestly both before and after that lands.
 * What decides the FORMAT is the value alone — a finite number is a
 * measurement, anything else is not — so a chip can never acquire a percent
 * sign it did not earn, whatever a caller puts in `state`.
 *
 * @param {{label?: string, value?: unknown, state?: string, stateReason?: string}} chip
 * @returns {{label: string, measured: boolean, value: string, state: string|null, reason: string|null}}
 */
export const describeEngineChip = (chip) => {
  const raw = chip?.value;
  const numeric =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))
        ? Number(raw)
        : null;
  const measured = numeric !== null && Number.isFinite(numeric);

  const declared =
    typeof chip?.state === 'string' && chip.state.trim() !== '' ? chip.state.trim() : null;

  /* A chip with no number MUST say something. The fallback is what stops an
     unmeasured engine from reading as a bare, confident dash. */
  const state = measured
    ? declared && !MEASURED_STATES.has(declared.toLowerCase())
      ? declared
      : null
    : declared || 'not measured';

  const reason =
    typeof chip?.stateReason === 'string' && chip.stateReason.trim() !== ''
      ? chip.stateReason.trim()
      : null;

  return {
    /* An unnameable engine says so; a chip reading " — not probed" is an empty
       state dressed as an explanation. */
    label:
      typeof chip?.label === 'string' && chip.label.trim() !== ''
        ? chip.label.trim()
        : 'an engine this scan did not name',
    measured,
    /* The percent sign lives here and nowhere else, behind `measured`. */
    value: measured ? `${numeric}%` : '—',
    state,
    reason,
  };
};

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
            {engineChips.map((chip, i) => {
              const c = describeEngineChip(chip);
              return (
                <span
                  key={chip?.key ?? `${c.label}-${i}`}
                  className={c.measured ? 'chip' : 'chip chip--warn'}
                  data-testid="engine-chip"
                  data-engine-measured={c.measured ? 'true' : 'false'}
                  data-engine-chip-state={c.state || undefined}
                  title={c.reason || undefined}
                >
                  {c.label} {c.value}
                  {c.state && (
                    <span style={{ color: 'var(--ink-3)', marginLeft: 4 }}>· {c.state}</span>
                  )}
                </span>
              );
            })}
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
