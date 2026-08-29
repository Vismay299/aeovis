'use client';

/**
 * Rivals.
 *
 * A discovered-brand table, ranked by how often each one takes an answer.
 * Rivals ramp down the neutral scale — a rival is never given a semantic
 * colour, because losing a question is not an error.
 */

import { RIVAL_RAMP } from '@/components/charts/FlowDiagram';
import { describeRosterState } from '@/lib/scoring/rosterContinuity';

export const RivalsView = ({
  competitors = [],
  results = [],
  competitorsConfigured,
  rosterSource = null,
}) => {
  // R0.3.2: an empty rival list means "none were co-mentioned" ONLY if the
  // extractor actually ran. When it did not, saying so is the whole point.
  const rosterState = describeRosterState(rosterSource);
  const answeredNonBranded = (results || []).filter(
    (r) =>
      !(r.is_branded_query ?? r.isBrandedQuery)
      && !!(r.aio_present ?? r.aioPresent),
  ).length;

  const withSignal = (competitors || []).filter(
    (c) => (c.visibilityScore ?? 0) > 0 || (c.mentions ?? 0) > 0 || (c.citations ?? 0) > 0,
  );
  const displayList = withSignal.length > 0 ? withSignal : competitors;

  const configured =
    competitorsConfigured != null ? !!competitorsConfigured : displayList.length > 0;

  const top = Math.max(1, ...displayList.map((c) => c.visibilityScore ?? 0));

  return (
    <div className="stack">
      <div className="panel" data-testid="competitor-table">
        <div className="panel__h">
          <b>Who else the answers name</b>
          <span className="tag">
            {displayList.length} rival{displayList.length === 1 ? '' : 's'}
          </span>
        </div>

        {!rosterState.assessable ? (
          <div className="blank" data-testid="competitor-not-assessed">
            <h4>{rosterState.label}</h4>
            <p>{rosterState.detail}</p>
            {displayList.length > 0 && (
              <p style={{ marginTop: 8 }}>
                {displayList.length} rival{displayList.length === 1 ? '' : 's'} shown below are
                carried forward from the previous scan and were not re-measured here.
              </p>
            )}
          </div>
        ) : displayList.length === 0 ? (
          <div className="blank" data-testid="competitor-empty">
            <h4>No rivals discovered yet</h4>
            <p>
              {configured
                ? 'No rival brands were co-mentioned in the answers for this scan.'
                : 'Rivals are discovered from the answers themselves. Re-run a scan to find them.'}
            </p>
          </div>
        ) : (
          <div className="panel__b">
            <p style={{ fontSize: 13.5, color: 'var(--ink-3)', marginBottom: 12 }}>
              Brands mentioned or cited alongside yours across {answeredNonBranded} answered
              non-branded questions. You never maintain this list.
            </p>
            <div className="rows">
              {displayList.map((c, i) => {
                const share = c.visibilityScore ?? 0;
                const colour = RIVAL_RAMP[Math.min(i, RIVAL_RAMP.length - 1)];
                return (
                  <div className="row" key={`${c.name}-${i}`} data-testid={`competitor-row-${i}`}>
                    <span className="row__n">
                      <i className="sw" style={{ background: colour }} aria-hidden="true" />
                      <b>{c.name}</b>
                      {c.source === 'discovered' && <span className="chip">Auto-found</span>}
                      {c.source === 'user' && <span className="chip">Tracked</span>}
                      {c.userAbsent && <span className="chip chip--crit">You absent</span>}
                    </span>
                    <span className="row__v">
                      {share}% <span className="dim">· {c.mentions ?? 0} text · {c.citations ?? 0} cited</span>
                    </span>
                    {/* --w is a ratio; the fill is scaled, never grown */}
                    <span className="row__bar">
                      <i style={{ '--w': share / top, '--d': `${i * 60}ms`, background: colour }} />
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default RivalsView;
