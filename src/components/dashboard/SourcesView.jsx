'use client';

import { summarizeSources } from '@/components/dashboard/sourcesMetrics';

/**
 * Sources.
 *
 * The pages the engines actually drew on, and which of them you control.
 * The ones you own are the accent; everything else is the shape of the work.
 *
 * The citation count comes from sourcesMetrics.js, which reads the field names
 * the v9 pipeline actually writes (`references` / `citations`, with the v8
 * `aio_*` names kept as a fallback for old scans) — see its header for why
 * this view used to print "Sources cited: 0" beside "Distinct domains: 14".
 */

export const SourcesView = ({ result }) => {
  const topDomains = result.topDomains || [];
  const { totalCitations, state: sourcesState, note: sourcesNote } = summarizeSources({
    rawResults: result.rawResults,
    topDomains,
  });
  const countUnavailable = totalCitations == null;

  const ownCount = topDomains
    .filter((d) => d.type === 'brand')
    .reduce((s, d) => s + (d.count || 0), 0);
  const rivalCount = topDomains
    .filter((d) => d.type === 'competitor')
    .reduce((s, d) => s + (d.count || 0), 0);

  // Two different empty states, deliberately not merged: "the engines cited
  // nothing" is a measurement, "nothing was counted" is the absence of one.
  if (countUnavailable && topDomains.length === 0) {
    return (
      <div className="panel">
        <div className="blank">
          <h4>
            Sources not recorded{' '}
            <span className="chip chip--warn" title={sourcesNote}>
              Not counted
            </span>
          </h4>
          <p>{sourcesNote}</p>
        </div>
      </div>
    );
  }

  if (totalCitations === 0 && topDomains.length === 0) {
    return (
      <div className="panel">
        <div className="blank">
          <h4>No citations captured</h4>
          <p>The engines did not cite any sources in the answers for this scan.</p>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="citations-panel" className="stack">
      <div className="grid g4">
        <div className="stat" data-testid="sources-cited">
          {/* A count that was never taken reads as an em dash and says so — it
              must not be indistinguishable from a scan the engines cited
              nothing in, and it must never contradict the domain list beside
              it. */}
          <span className="stat__k">Sources cited</span>
          <span className="stat__v">
            {countUnavailable ? (
              <>
                —{' '}
                <span className="chip chip--warn" title={sourcesNote}>
                  {sourcesState === 'inconsistent' ? 'Count unavailable' : 'Not counted'}
                </span>
              </>
            ) : (
              totalCitations
            )}
          </span>
          <span className="stat__d dim">
            {countUnavailable ? sourcesNote : 'URLs referenced across all answers'}
          </span>
        </div>
        <div className="stat">
          <span className="stat__k">Distinct domains</span>
          <span className="stat__v">{topDomains.length}</span>
          <span className="stat__d dim">The shape of the work</span>
        </div>
        <div className="stat">
          <span className="stat__k">Pages you control</span>
          <span className="stat__v is-you">{ownCount}</span>
          <span className="stat__d dim">Where the content operation starts</span>
        </div>
        <div className="stat">
          <span className="stat__k">Your domain share</span>
          <span className="stat__v is-you">
            {result.brandCitationSharePct ?? 0}<small>%</small>
          </span>
          <span className="stat__d dim">
            of non-branded answers citing you{rivalCount > 0 ? ` · rivals cited ${rivalCount}×` : ''}
          </span>
        </div>
      </div>

      <div className="panel">
        <div className="panel__h">
          <b>Cited domains</b>
          <span className="tag">
            {topDomains.length} shown
          </span>
        </div>
        <div className="panel__b panel__b--flush">
          {topDomains.map((item, i) => (
            <div className="src" key={item.domain}>
              <span className={`src__d${item.type === 'brand' ? ' mine' : ''}`} title={item.domain}>
                <span className="dim" style={{ marginRight: 10 }}>
                  {String(i + 1).padStart(2, '0')}
                </span>
                {item.domain}
              </span>
              <span className="row__v" style={{ textAlign: 'right' }}>{item.count}</span>
              <span style={{ display: 'flex', justifyContent: 'flex-end' }}>
                {item.type === 'brand' && <span className="chip chip--you">Yours</span>}
                {item.type === 'competitor' && <span className="chip">Rival</span>}
                {item.type !== 'brand' && item.type !== 'competitor' && (
                  <span className="chip">Third party</span>
                )}
              </span>
            </div>
          ))}
          {topDomains.length === 0 && (
            <div className="blank">
              <h4>No domain data yet</h4>
              <p>Citations were counted but no domains could be resolved from them.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default SourcesView;
