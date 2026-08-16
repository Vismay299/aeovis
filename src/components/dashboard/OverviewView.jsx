'use client';

/**
 * Overview.
 *
 * Four figures, then where the answers actually went, then how each engine
 * did, then what to do about it. The verdict sits above this in the shell,
 * so this view's job is to explain the number rather than restate it.
 */

import { ArrowRight } from 'lucide-react';
import { FlowDiagram, RIVAL_RAMP } from '@/components/charts/FlowDiagram';
import { Gauge } from '@/components/charts/Gauge';
import { buildInterlocking } from './interlocking';
import { OverviewAnalytics } from './OverviewAnalytics';

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

  return (
    <div className="stack">
      {/* ── the four figures ─────────────────────────────────────── */}
      <div className="grid g4">
        <div className="stat" data-testid="kpi-aio-coverage">
          <span className="stat__k">Answer coverage</span>
          <span className="stat__v">
            {dataSourceIssue ? '—' : Math.round(aioCoverage ?? 0)}<small>%</small>
          </span>
          <span className="stat__d dim">
            {nonBrandedWithAio ?? 0} of {promptsTracked ?? 0} returned an answer
          </span>
        </div>

        <div className="stat" data-testid="kpi-presence">
          <span className="stat__k">Your presence</span>
          <span className="stat__v is-you">
            {dataSourceIssue ? '—' : Math.round(presenceRate ?? 0)}<small>%</small>
          </span>
          <span className="stat__d dim">
            {visibleCount ?? 0} of {promptsTracked ?? 0} answers name you
          </span>
        </div>

        <div className="stat" data-testid="kpi-prompts">
          <span className="stat__k">Questions tracked</span>
          <span className="stat__v">{promptsTracked ?? promptsAnalyzed ?? 0}</span>
          <span className="stat__d dim">Unbranded, never leading</span>
        </div>

        <div className="stat" data-testid="kpi-competitors">
          <span className="stat__k">Rivals holding answers</span>
          <span className="stat__v">{competitorsFound ?? 0}</span>
          <span className="stat__d dim">
            {(competitorsFound ?? 0) === 0
              ? 'None co-mentioned yet'
              : 'Found in the answers themselves'}
          </span>
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
                <FlowDiagram
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
            <span className="tag">{engines.length} reporting</span>
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
