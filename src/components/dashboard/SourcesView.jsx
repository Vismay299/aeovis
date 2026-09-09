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

/**
 * R2.2.11 — "Your domain share", and when there is no share, WHY.
 *
 * This used to be `{result.brandCitationSharePct ?? 0}<small>%</small>`, which
 * is standing rule 5 broken on the one surface the whole citation-share chain
 * ends at. R2.2.11 taught the scan-level mirror (enginePipeline.js) and the
 * rollup to publish `null` when the citation denominator is empty — every
 * answered non-branded row's citation list unobserved, so there was nothing to
 * divide by. That null then died TWICE on its way here, and both deaths are
 * fixed in the same commit: once at services/api.js (the normalizer ended with
 * its own `citationSharePct ?? 0`, three lines before the only consumer) and
 * once on this line. Either one alone turned "nobody could look" into a
 * confident "0% of non-branded answers citing you", byte-identical to a scan
 * where every citation list was read in full and the brand was in none of them.
 *
 * Those two are different facts and now look different. A number renders as a
 * number; the absence of one renders as an em dash, a state chip, and the
 * reason read off the per-engine slice the missing number mirrors
 * (`citation_denominator` / `citations_unverified_count`, emitted by
 * summarizeEngineSlice in src/lib/scoring/enginePipeline.js and exposed as
 * `result.perEngineSummaries` by services/api.js) — see the slice selection
 * below for why it is one slice and not all of them.
 *
 * THE INVERSE MATTERS AS MUCH: a GENUINE 0 must still print "0%". Blanking a
 * real measurement is the same crime in the other direction, so the test is on
 * `Number.isFinite`, never on truthiness. A numeric string is accepted for the
 * same reason and no other: a driver that hands "0.0" back from a numeric
 * column must not be read as "not measured". That has not been observed on this
 * path — it is guarded because guessing wrong blanks a real zero.
 *
 * @param {object} result - the normalized scan (services/api.js)
 * @returns {{value: number|null, chip: string|null, note: string|null}}
 */
export function describeCitationShare(result) {
  const raw = result?.brandCitationSharePct;
  const numeric =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim() !== ''
        ? Number(raw)
        : NaN;
  if (Number.isFinite(numeric)) return { value: numeric, chip: null, note: null };

  // No number. Say which flavour of "no number" this is, using only what the
  // record actually carries — an invented reason would be the same failure as
  // the invented zero.
  //
  // READ THE SLICE THE MISSING NUMBER CAME FROM, not all of them. The scan-level
  // share is a MIRROR of one engine summary: summarizeEngineResults takes
  // `engines.aio || Object.values(engines)[0]` (src/lib/scoring/enginePipeline
  // .js) and divides that slice's `cited_non_branded` by that slice's
  // `citation_denominator`. On a multi-engine scan the other slices can have
  // healthy denominators while the mirrored one has none — summing them would
  // explain the null with counters that had nothing to do with it.
  const engines = result?.perEngineSummaries;
  const slice =
    engines && typeof engines === 'object'
      ? engines.aio || Object.values(engines).find((s) => s && typeof s === 'object') || null
      : null;
  const readCount = (key) => (Number.isFinite(slice?.[key]) ? slice[key] : null);
  const denominator = readCount('citation_denominator');
  const unverified = readCount('citations_unverified_count');
  const answered = readCount('non_branded_with_answer');

  if (denominator === 0 && unverified > 0) {
    const of = Number.isFinite(answered) ? ` of ${answered}` : '';
    return {
      value: null,
      chip: 'Not measured',
      note:
        `No citation list could be read on this scan — ${unverified}${of} answered ` +
        `non-branded ${unverified === 1 ? 'answer' : 'answers'} came back unverified, ` +
        `so there was no pool to divide by. This is not a 0% share.`,
    };
  }
  if (denominator === 0) {
    return {
      value: null,
      chip: 'Not measured',
      note:
        'No non-branded answer reached the citation stage, so there was nothing to ' +
        'compute a share over. This is not a 0% share.',
    };
  }
  return {
    value: null,
    chip: 'Not measured',
    note:
      'This scan recorded no citation denominator, so a domain share could not be ' +
      'computed. This is not a 0% share.',
  };
}

export const SourcesView = ({ result }) => {
  const topDomains = result.topDomains || [];
  const { totalCitations, state: sourcesState, note: sourcesNote } = summarizeSources({
    rawResults: result.rawResults,
    topDomains,
  });
  const countUnavailable = totalCitations == null;
  const citationShare = describeCitationShare(result);

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
        <div className="stat" data-testid="brand-citation-share">
          {/* See describeCitationShare above: a share nobody could compute is an
              em dash plus a state chip plus the reason, never 0%. A measured 0
              is still the number 0. */}
          <span className="stat__k">Your domain share</span>
          <span className="stat__v is-you">
            {citationShare.value == null ? (
              <>
                —{' '}
                <span className="chip chip--warn" title={citationShare.note}>
                  {citationShare.chip}
                </span>
              </>
            ) : (
              <>
                {citationShare.value}
                <small>%</small>
              </>
            )}
          </span>
          <span className="stat__d dim">
            {citationShare.value == null
              ? citationShare.note
              : `of non-branded answers citing you${rivalCount > 0 ? ` · rivals cited ${rivalCount}×` : ''}`}
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
