'use client';

/**
 * Sources.
 *
 * The pages the engines actually drew on, and which of them you control.
 * The ones you own are the accent; everything else is the shape of the work.
 */

export const SourcesView = ({ result }) => {
  const topDomains = result.topDomains || [];
  const totalCitations = (result.rawResults || []).reduce(
    (sum, r) => sum + ((r.aio_citations || r.aio_references || []).length),
    0,
  );

  const ownCount = topDomains
    .filter((d) => d.type === 'brand')
    .reduce((s, d) => s + (d.count || 0), 0);
  const rivalCount = topDomains
    .filter((d) => d.type === 'competitor')
    .reduce((s, d) => s + (d.count || 0), 0);

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
        <div className="stat">
          <span className="stat__k">Sources cited</span>
          <span className="stat__v">{totalCitations}</span>
          <span className="stat__d dim">URLs referenced across all answers</span>
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
