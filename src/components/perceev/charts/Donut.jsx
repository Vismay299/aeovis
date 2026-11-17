'use client';

import { formatPercent, neutralRampVar } from './chartMath';
import { SHARE_STATE, NOT_AVAILABLE_LABEL } from './shareOfVoice';
import { describeRosterState } from '@/shared/scoring/rosterContinuity';

/**
 * Share of the line.
 *
 * Not a ring. One continuous run of track divided into the shares that hold
 * it, read left to right with your own section in bone and every rival on a
 * step of the neutral steel ramp — a rival's size is a quantity, never an
 * alarm. The component keeps its old name because the whole dashboard
 * imports it under that name.
 *
 * R2.7.1 (finding A8): this component no longer computes a share. It used to
 * take `segments` — the rank board's self + rival VISIBILITY scores — and
 * divide each by their sum, which printed a visibility number under the words
 * "share of voice" and, with a self-only list, a flat "100.0% share". It is now
 * handed an already-measured `share` object (see ./shareOfVoice.js, which reads
 * the pipeline's `share_of_voice_pct` and nothing else) and only draws it. With
 * no measurement there is no bar and no percentage: an em dash, a state chip
 * reading "not available", and the sentence saying why.
 */

/** Largest rival takes the brightest steel step; the smallest stays visible. */
function rivalRampT(rank, total) {
  if (total <= 1) return 1;
  return 0.2 + (1 - rank / (total - 1)) * 0.8;
}

export const Donut = ({
  share = null,
  centerLabel = 'share of the line',
  showLegend = true,
  keyline = null,
  testId = 'sov-donut',
  rosterSource = null,
}) => {
  // R0.3.2: a share drawn for a scan whose rival extractor never ran is a
  // confident number about a question nobody asked. `rosterSource` says which
  // happened; when it says the extractor was offline this renders the state
  // instead of the number. resolveShareOfVoice() consults the same function,
  // so the two can only ever agree — this call is what keeps the decision
  // visible in the component that renders it.
  const rosterState = describeRosterState(rosterSource);
  const state = share?.state ?? SHARE_STATE.UNAVAILABLE;
  const measured = rosterState.assessable && state === SHARE_STATE.MEASURED;

  // The one percentage this component prints. It is READ, never derived: there
  // is no total to divide by here any more, so the old one-segment 100% cannot
  // be reconstructed.
  const selfPct =
    rosterState.assessable && measured && typeof share?.pct === 'number' ? share.pct : null;

  const slices = measured && Array.isArray(share?.composition) ? share.composition : [];
  const hasComposition = slices.length > 0;

  const rivalsByPct = slices
    .filter((s) => !s.isSelf)
    .slice()
    .sort((a, b) => (b.pct || 0) - (a.pct || 0))
    .map((s) => s.name);

  const colorFor = (slice) => {
    if (slice.isSelf) return 'var(--lamp-white)';
    if (slice.isOther) return neutralRampVar(0);
    return neutralRampVar(rivalRampT(rivalsByPct.indexOf(slice.name), rivalsByPct.length));
  };

  // Not-assessed (extractor offline) and not-available (nothing measured) are
  // different facts and get different sentences; a measured 0.0% is neither.
  const stateLabel = rosterState.assessable
    ? share?.label ?? NOT_AVAILABLE_LABEL
    : rosterState.label;
  const stateDetail = rosterState.assessable ? share?.detail ?? null : rosterState.detail;

  return (
    <div
      data-testid={testId}
      className="sb-panel"
      style={{
        borderTop: keyline ? `2px solid var(--lamp-${keyline})` : undefined,
        padding: 'var(--space-5)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-4)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-3)' }}>
        <span
          data-testid={`${testId}-headline`}
          className="t-tally"
          style={{ fontSize: 34, lineHeight: 1, color: 'var(--lamp-white)' }}
        >
          {selfPct == null ? '—' : formatPercent(selfPct)}
        </span>
        {selfPct == null ? (
          <span
            data-testid={`${testId}-state-chip`}
            className="t-plate"
            style={{
              border: '1px solid var(--rule-1)',
              borderRadius: '2px',
              padding: '2px 6px',
              color: 'var(--text-3)',
            }}
          >
            {stateLabel}
          </span>
        ) : (
          <span className="t-plate">{centerLabel}</span>
        )}
      </div>

      {/* Two different facts, two different ids: `-not-assessed` still means
          exactly what R0.3.2 gave it (the rival extractor never ran), and
          `-unavailable` means the roster was fine but no share was measured. */}
      {selfPct == null && stateDetail && (
        <p
          data-testid={rosterState.assessable ? `${testId}-unavailable` : `${testId}-not-assessed`}
          style={{ fontSize: 13, color: 'var(--text-3)', margin: 0 }}
        >
          {stateDetail}
        </p>
      )}

      {/* the run of track, divided by who holds it */}
      <div
        style={{
          display: 'flex',
          gap: '2px',
          height: '18px',
          background: 'var(--panel-0)',
          border: '1px solid var(--rule-1)',
          borderRadius: '1px',
          padding: '2px',
          boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.45)',
        }}
      >
        {!hasComposition && <div className="sb-hatch" style={{ flex: 1, borderRadius: '1px' }} />}
        {hasComposition &&
          slices.map((slice, i) => {
            const pct = Number(slice.pct) || 0;
            if (pct <= 0) return null;
            return (
              <div
                key={`${slice.name ?? 'slice'}-${i}`}
                title={`${slice.name}: ${formatPercent(pct)}`}
                style={{
                  flex: `${pct} 0 0`,
                  minWidth: '2px',
                  background: colorFor(slice),
                  borderRadius: '1px',
                }}
              />
            );
          })}
      </div>

      {measured && !hasComposition && (
        <p
          data-testid={`${testId}-no-composition`}
          style={{ fontSize: 13, color: 'var(--text-3)', margin: 0 }}
        >
          The share above is measured; the per-brand split behind it was not stored for this scan,
          so the run of track is left blank rather than divided by a guess.
        </p>
      )}

      {showLegend && hasComposition && (
        <div style={{ display: 'grid', gap: '6px' }}>
          {slices.map((slice, i) => (
            <div
              key={`${slice.name ?? 'legend'}-${i}`}
              style={{ display: 'flex', alignItems: 'center', gap: '9px' }}
            >
              <span
                style={{
                  width: '11px',
                  height: '8px',
                  flexShrink: 0,
                  borderRadius: '1px',
                  background: colorFor(slice),
                }}
              />
              <span
                style={{
                  fontSize: '13px',
                  fontWeight: slice.isSelf ? 700 : 450,
                  color: slice.isSelf ? 'var(--text-1)' : 'var(--text-2)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {slice.name}
              </span>
              <span
                className="t-tally"
                style={{ marginLeft: 'auto', fontSize: '13px', color: 'var(--text-3)' }}
              >
                {formatPercent(slice.pct)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
