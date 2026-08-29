'use client';

import { formatPercent, neutralRampVar } from './chartMath';
import { describeRosterState } from '@/lib/scoring/rosterContinuity';

/**
 * Share of the line.
 *
 * Not a ring. One continuous run of track divided into the shares that hold
 * it, read left to right with your own section in bone and every rival on a
 * step of the neutral steel ramp — a rival's size is a quantity, never an
 * alarm. The component keeps its old name because the whole dashboard
 * imports it under that name.
 */

/** Largest rival takes the brightest steel step; the smallest stays visible. */
function rivalRampT(rank, total) {
  if (total <= 1) return 1;
  return 0.2 + (1 - rank / (total - 1)) * 0.8;
}

export const Donut = ({
  segments,
  centerLabel = 'share of the line',
  showLegend = true,
  keyline = null,
  testId = 'sov-donut',
  rosterSource = null,
}) => {
  // R0.3.2: with one segment (self alone) the share arithmetic below produces
  // a confident 100%. That is only true if the extractor RAN and found no
  // rivals. `rosterSource` says which happened; when it says the extractor was
  // offline this renders the state instead of the number.
  const rosterState = describeRosterState(rosterSource);
  const safe = Array.isArray(segments) ? segments : [];
  const total = safe.reduce((s, seg) => s + (Number(seg.value) || 0), 0);
  const hasData = total > 0;

  const rivalsByValue = safe
    .filter((s) => !s.isSelf)
    .slice()
    .sort((a, b) => (b.value || 0) - (a.value || 0))
    .map((s) => s.name);

  const colorFor = (seg) =>
    seg.isSelf
      ? 'var(--lamp-white)'
      : neutralRampVar(rivalRampT(rivalsByValue.indexOf(seg.name), rivalsByValue.length));

  const selfSeg = safe.find((s) => s.isSelf) || safe[0];
  const selfPct =
    rosterState.assessable && hasData && selfSeg
      ? ((Number(selfSeg.value) || 0) / total) * 100
      : null;

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
        <span className="t-tally" style={{ fontSize: 34, lineHeight: 1, color: 'var(--lamp-white)' }}>
          {selfPct == null ? '—' : formatPercent(selfPct)}
        </span>
        <span className="t-plate">{rosterState.assessable ? centerLabel : rosterState.label}</span>
      </div>

      {!rosterState.assessable && (
        <p
          data-testid={`${testId}-not-assessed`}
          style={{ fontSize: 13, color: 'var(--text-3)', margin: 0 }}
        >
          {rosterState.detail}
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
        {(!hasData || !rosterState.assessable) && (
          <div className="sb-hatch" style={{ flex: 1, borderRadius: '1px' }} />
        )}
        {hasData &&
          rosterState.assessable &&
          safe.map((seg, i) => {
            const pct = ((Number(seg.value) || 0) / total) * 100;
            if (pct <= 0) return null;
            return (
              <div
                key={`${seg.name ?? 'seg'}-${i}`}
                title={`${seg.name}: ${formatPercent(pct)}`}
                style={{
                  flex: `${pct} 0 0`,
                  minWidth: '2px',
                  background: colorFor(seg),
                  borderRadius: '1px',
                }}
              />
            );
          })}
      </div>

      {showLegend && rosterState.assessable && (
        <div style={{ display: 'grid', gap: '6px' }}>
          {safe.map((seg, i) => {
            const pct = hasData ? ((Number(seg.value) || 0) / total) * 100 : 0;
            return (
              <div
                key={`${seg.name ?? 'legend'}-${i}`}
                style={{ display: 'flex', alignItems: 'center', gap: '9px' }}
              >
                <span
                  style={{
                    width: '11px',
                    height: '8px',
                    flexShrink: 0,
                    borderRadius: '1px',
                    background: colorFor(seg),
                  }}
                />
                <span
                  style={{
                    fontSize: '13px',
                    fontWeight: seg.isSelf ? 700 : 450,
                    color: seg.isSelf ? 'var(--text-1)' : 'var(--text-2)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {seg.name}
                </span>
                <span
                  className="t-tally"
                  style={{ marginLeft: 'auto', fontSize: '13px', color: 'var(--text-3)' }}
                >
                  {formatPercent(pct)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
