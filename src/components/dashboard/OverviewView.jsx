'use client';

/**
 * Overview.
 *
 * Four figures, then where the answers actually went, then how each engine
 * did, then what to do about it. The verdict sits above this in the shell,
 * so this view's job is to explain the number rather than restate it.
 */

import { ArrowRight } from 'lucide-react';
import { FlowDiagram, RIVAL_RAMP } from '@/components/perceev/charts/FlowDiagram';
import { Gauge } from '@/components/perceev/charts/Gauge';
import { describeRosterState } from '@/shared/scoring/rosterContinuity';
import { buildInterlocking } from './interlocking';
import { OverviewAnalytics } from './OverviewAnalytics';

/**
 * R2.7.12 — "Rivals holding answers", and when nobody counted, WHY.
 *
 * This KPI used to be `{competitorsFound ?? 0}` over the sentence
 * `(competitorsFound ?? 0) === 0 ? 'None co-mentioned yet' : ...`. Both halves
 * are standing rule 5 broken on a LIVE surface: page.js -> DashboardShell ->
 * OverviewView. The zero is bad on its own; the zero plus "None co-mentioned
 * yet" is worse, because it upgrades an absent measurement into a stated
 * finding about the market.
 *
 * THERE ARE TWO WAYS THE COUNT IS UNMEASURED, and only one of them is the
 * literal `?? 0`:
 *
 *   1. The prop is absent. `services/api.js` normalizeResult() always derives
 *      `competitorsFound` through countCompetitorsFound(), so on the shipped
 *      path a number always arrives — the `?? 0` was a guard against a caller
 *      that has not been written. Left handled, because the fallback it
 *      replaced was a confident 0 either way.
 *   2. The count is a real `0` produced from an EMPTY ROSTER, and the roster is
 *      empty because rival extraction never ran. countCompetitorsFound([]) is 0
 *      whether the extractor read every answer and found nobody or never
 *      opened its mouth. This is the case that actually reaches customers, and
 *      no amount of nullish-checking finds it — the discriminator is
 *      `roster_source`, which the scan already carries.
 *
 * `describeRosterState` (src/shared/scoring/rosterContinuity.js) is the repo's
 * single predicate for case 2; RivalsView, Donut and VisibilityVerdictPanel all
 * read it, and this surface now reads the same one rather than comparing
 * `roster_source` strings of its own. `rosterSource == null` (a scan taken
 * before R0.3.3) counts as assessable, so legacy scans keep printing numbers.
 *
 * THE INVERSE MATTERS AS MUCH: a MEASURED zero must still print "0" and still
 * say "None co-mentioned yet". Blanking a real finding is the same crime in
 * the other direction, so the numeric test is `Number.isFinite`, never
 * truthiness.
 *
 * @param {number|string|null|undefined} competitorsFound
 * @param {string|null|undefined} rosterSource the scan's `roster_source`
 * @returns {{value: number|null, chip: string|null, note: string}}
 */
export function describeCompetitorCount(competitorsFound, rosterSource) {
  const roster = describeRosterState(rosterSource);
  if (!roster.assessable) {
    // Word the reason with the shared helper's sentence, not a local paraphrase
    // — three surfaces disagreeing about why a rival count is missing is
    // exactly what that helper exists to prevent.
    return { value: null, chip: 'Not measured', note: roster.detail };
  }

  const raw = competitorsFound;
  const numeric =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim() !== ''
        ? Number(raw)
        : NaN;
  if (!Number.isFinite(numeric)) {
    return {
      value: null,
      chip: 'Not measured',
      note:
        'This reading carries no rival count, so how many brands hold answers ' +
        'is unknown. This is not a finding that none do.',
    };
  }

  return {
    value: numeric,
    chip: null,
    note: numeric === 0 ? 'None co-mentioned yet' : 'Found in the answers themselves',
  };
}

export const OverviewView = ({
  result,
  dataSourceIssue,
  onTabChange,
  heroScore,
  aioCoverage,
  nonBrandedWithAio,
  promptsTracked,
  presenceRate,
  visibleCount,
  competitorsFound,
  promptsAnalyzed,
  mentionedNonBrandedCount,
  citedNonBrandedCount,
  interpretation,
  tier,
}) => {
  const { engines, platforms, total, answered } = buildInterlocking(result);

  /* R2.8.2 — "N reporting" counts only engines that actually produced rows,
     not every engine the scan was frozen with. An engine whose gauges show
     "no data" must not inflate the reporting count. */
  const reportingEngines = engines.filter((e) => !e.noData);

  /* Destinations, coloured by role: you are always indigo, rivals ramp down
     the neutral scale in rank order, nobody-named takes the flattest tone. */
  let rivalIdx = 0;
  const destinations = platforms
    .filter((p) => p.count > 0)
    .map((p) => ({
      key: p.key,
      label: p.name,
      answers: p.count,
      isYou: p.isYou,
      muted: p.isNobody,
      colour: p.isYou
        ? 'var(--you)'
        : p.isNobody
          ? 'var(--none)'
          : RIVAL_RAMP[Math.min(rivalIdx++, RIVAL_RAMP.length - 1)],
    }));

  const tierChip = { strong: 'chip chip--good', moderate: 'chip chip--warn', weak: 'chip chip--crit' };
  const lostCount = Math.max(0, (answered || 0) - (mentionedNonBrandedCount ?? 0));
  const competitorCount = describeCompetitorCount(competitorsFound, result?.rosterSource ?? null);

  return (
    <div className="stack">
      {/* ── the four figures ─────────────────────────────────────── */}
      {/* WHICH OF THESE IS SHIELDED, AND WHY IT IS NOT AN ACCIDENT (R2.7.12).
          Answer coverage and Your presence below print an em dash when
          `dataSourceIssue` is set, so their `?? 0` can only be reached on a
          reading the shell has already declared adequate — and in fact cannot
          be reached at all through the shipped route, because DashboardShell
          swaps this whole view for `dashboard-unreliable-placeholder` when
          `dataSourceIssue` is true. Their guard is kept (this component is
          exported and a future caller may mount it without that swap) and
          their fallbacks are deliberately left alone.
          "Rivals holding answers" had NO such guard, and `dataSourceIssue`
          would not have been the right one anyway: a scan with perfectly good
          answer coverage can still have had rival extraction offline. It reads
          `roster_source` instead — see describeCompetitorCount above. */}
      <div className="grid g4">
        <div className="stat" data-testid="kpi-aio-coverage">
          <span className="stat__k">Answer coverage</span>
          <span className="stat__v">
            {dataSourceIssue || aioCoverage == null || !Number.isFinite(aioCoverage) ? (
              '—'
            ) : (
              <>{Math.round(aioCoverage)}<small>%</small></>
            )}
          </span>
          <span className="stat__d dim">
            {nonBrandedWithAio == null ? '—' : nonBrandedWithAio} of {promptsTracked == null ? '—' : promptsTracked} returned an answer
          </span>
        </div>

        <div className="stat" data-testid="kpi-presence">
          <span className="stat__k">Your presence</span>
          <span className="stat__v is-you">
            {dataSourceIssue || presenceRate == null || !Number.isFinite(presenceRate) ? (
              '—'
            ) : (
              <>{Math.round(presenceRate)}<small>%</small></>
            )}
          </span>
          <span className="stat__d dim">
            {visibleCount == null ? '—' : visibleCount} of {promptsTracked == null ? '—' : promptsTracked} answers name you
          </span>
        </div>

        <div className="stat" data-testid="kpi-prompts">
          <span className="stat__k">Questions tracked</span>
          <span className="stat__v">
            {promptsTracked == null && promptsAnalyzed == null
              ? '—'
              : (promptsTracked ?? promptsAnalyzed)}
          </span>
          <span className="stat__d dim">Unbranded, never leading</span>
        </div>

        <div className="stat" data-testid="kpi-competitors">
          <span className="stat__k">Rivals holding answers</span>
          <span className="stat__v" data-state={competitorCount.value == null ? 'not-measured' : 'measured'}>
            {competitorCount.value == null ? (
              <>
                —{' '}
                <span className="chip chip--warn" title={competitorCount.note}>
                  {competitorCount.chip}
                </span>
              </>
            ) : (
              competitorCount.value
            )}
          </span>
          <span className="stat__d dim">{competitorCount.note}</span>
        </div>
      </div>

      {/* ── who holds the answer ─────────────────────────────────── */}
      <div className="grid g-wide">
        <div className="panel">
          <div className="panel__h">
            <b>Who holds the answer</b>
            <span className="tag">{answered || 0} answered</span>
          </div>
          <div className="panel__b">
            {destinations.length > 0 ? (
              <>
                <FlowDiagram revealed
                  total={answered || total}
                  destinations={destinations}
                  setLabel="ANSWERED"
                />
                <div className="legend">
                  {destinations.map((d) => (
                    <span key={d.key}>
                      <i style={{ background: d.colour }} />
                      {d.label} · {d.answers}
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <div className="blank">
                <h4>No answers to attribute yet</h4>
                <p>
                  Once the engines return answers for the tracked set, this shows which brand each
                  one named.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* ── coverage by engine ─────────────────────────────────── */}
        {/* `engine-breakdown` was the deleted EngineBreakdown component's id;
            this panel is what shows that data now, so it keeps the name. */}
        <div className="panel" data-testid="engine-breakdown">
          <div className="panel__h">
            <b>Coverage by engine</b>
            <span className="tag" data-testid="engine-reporting-count">{reportingEngines.length} reporting</span>
          </div>
          <div className="panel__b">
            <p style={{ fontSize: 13.5, color: 'var(--ink-3)', marginBottom: 4 }}>
              The mark is where you land; the line is half the set.
            </p>
            {engines.map((e, i) => (
              <Gauge
                key={e.key}
                name={e.name}
                reached={e.cleared}
                asked={e.probes}
                delay={i * 110}
              />
            ))}
          </div>
        </div>
      </div>

      <OverviewAnalytics result={result} heroScore={heroScore} />

      {/* ── what to do ───────────────────────────────────────────── */}
      <div className="grid g2">
        <button
          type="button"
          className="panel"
          onClick={() => onTabChange?.('answers')}
          data-testid="where-losing-card"
          style={{ textAlign: 'left', cursor: 'pointer', padding: 0 }}
        >
          <div className="panel__h">
            <b>Answers you do not hold</b>
            <span className="chip chip--warn">{lostCount} lost</span>
          </div>
          <div className="panel__b">
            <h3 style={{ marginBottom: 10 }}>
              Named in {mentionedNonBrandedCount ?? 0} of {answered || 0} answers
            </h3>
            <p style={{ fontSize: 14.5, color: 'var(--ink-3)', marginBottom: 14 }}>
              Every answer that named someone else is a recommendation that could have been yours.
              Open the answers to read the exact wording, question by question.
            </p>
            <span className="btn btn--ghost btn--sm">
              Read the answers <ArrowRight size={13} aria-hidden="true" />
            </span>
          </div>
        </button>

        <div className="panel" data-testid="insight-panel">
          <div className="panel__h">
            <b>What the reading means</b>
            {tier && (
              <span className={`${tierChip[tier] || 'chip'}`} style={{ marginLeft: 'auto' }}>
                {tier} · {heroScore ?? result.visibilityScore}%
              </span>
            )}
          </div>
          <div className="panel__b">
            <p
              data-testid="insight-interpretation"
              style={{ fontSize: 15, color: 'var(--ink-1)', lineHeight: 1.6 }}
            >
              {interpretation}
            </p>
            {result.summary && (
              <p
                style={{
                  fontSize: 14, color: 'var(--ink-3)', lineHeight: 1.6, marginTop: 14,
                  paddingTop: 14, borderTop: '1px solid var(--line-soft)',
                }}
              >
                {result.summary}
              </p>
            )}
            {citedNonBrandedCount > 0 && (
              <p className="tag" style={{ marginTop: 14 }}>
                {citedNonBrandedCount} of those answers cited a page you control
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default OverviewView;
