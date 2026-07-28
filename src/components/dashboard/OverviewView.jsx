'use client';

/**
 * Overview — the interlocking is the page.
 *
 * The organising graphic is the diagram itself: questions in on the left,
 * routes resolving to your platform or a rival's on the right. The numbers
 * sit under it as one instrument bank, not four floating tiles, and the two
 * readings that need words follow as panels.
 */

import { ArrowRight } from 'lucide-react';
import { KpiCard } from '@/components/perceev/KpiCard';
import { Card } from '@/components/perceev/Card';
import { Badge } from '@/components/perceev/Badge';
import { ReadoutStrip } from '@/components/signal/ReadoutStrip';
import { RouteDiagram, buildInterlocking } from '@/components/signal/RouteDiagram';
import { AspectSignal, aspectForTier } from '@/components/signal/Lamp';
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
  const { engines, platforms, total } = buildInterlocking(result);
  const aspect = aspectForTier(tier);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      {/* The diagram leads. Everything below explains it. */}
      <RouteDiagram
        engines={engines}
        platforms={platforms}
        total={total || promptsTracked || promptsAnalyzed || 0}
        plate={`interlocking · ${result.brand || 'this brand'}`}
      />

      {/* One instrument bank, divided by scribed rules. */}
      <ReadoutStrip plate="readings">
        <KpiCard
          testId="kpi-aio-coverage"
          label="answer coverage"
          value={dataSourceIssue ? null : aioCoverage ?? 0}
          suffix="%"
          tone={dataSourceIssue ? 'crit' : (aioCoverage ?? 0) < 30 ? 'warn' : 'good'}
          sub={`${nonBrandedWithAio ?? 0} of ${promptsTracked ?? 0} questions returned an answer`}
        />
        <KpiCard
          testId="kpi-presence"
          label="your presence"
          value={dataSourceIssue ? null : presenceRate ?? 0}
          suffix="%"
          tone="you"
          sub={`${visibleCount ?? 0} of ${promptsTracked ?? 0} questions name you`}
        />
        <KpiCard
          testId="kpi-prompts"
          label="questions tracked"
          value={promptsTracked ?? promptsAnalyzed ?? 0}
          sub="unbranded, never leading"
        />
        <KpiCard
          testId="kpi-competitors"
          label="rivals holding line"
          value={competitorsFound ?? 0}
          tone={(competitorsFound ?? 0) > 0 ? 'crit' : 'neutral'}
          sub={
            (competitorsFound ?? 0) === 0
              ? 'none co-mentioned yet'
              : 'found in the answers themselves'
          }
        />
      </ReadoutStrip>

      <OverviewAnalytics result={result} heroScore={heroScore} />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          gap: 'var(--space-5)',
        }}
      >
        <Card variant="flush">
          <button
            onClick={() => onTabChange?.('answers')}
            data-testid="where-losing-card"
            style={{
              width: '100%',
              textAlign: 'left',
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              fontFamily: 'inherit',
              color: 'inherit',
              display: 'block',
            }}
          >
            <div className="sb-panel__head">
              <span className="t-plate">sections you do not hold</span>
            </div>
            <div style={{ padding: 'var(--space-5)' }}>
              <h3
                className="t-sig"
                style={{ fontSize: 22, marginBottom: 'var(--space-3)', lineHeight: 1.05 }}
              >
                Named in {mentionedNonBrandedCount ?? 0} of {nonBrandedWithAio ?? 0} answers
              </h3>
              <p style={{ font: 'var(--type-body)', color: 'var(--text-2)', marginBottom: 'var(--space-4)' }}>
                Every answer that named someone else is a route that could have been yours. Open
                the answers to see the exact wording, question by question.
              </p>
              <span className="lp-link" style={{ color: 'var(--text-1)' }}>
                read the answers <ArrowRight size={12} />
              </span>
            </div>
          </button>
        </Card>

        <Card variant="flush" data-testid="insight-panel">
          <div className="sb-panel__head">
            <span className="t-plate">what the reading means</span>
            {tier && (
              <span style={{ marginLeft: 'auto' }}>
                <AspectSignal aspect={aspect} size="sm" showName />
              </span>
            )}
          </div>
          <div style={{ padding: 'var(--space-5)' }}>
            {tier && (
              <div style={{ marginBottom: 'var(--space-4)' }}>
                <Badge variant={tier === 'strong' ? 'strong' : tier === 'moderate' ? 'moderate' : 'weak'}>
                  {tier} at {heroScore ?? result.visibilityScore}/100
                </Badge>
              </div>
            )}
            <p
              data-testid="insight-interpretation"
              style={{ font: 'var(--type-body)', color: 'var(--text-1)', lineHeight: 1.6 }}
            >
              {interpretation}
            </p>
            {result.summary && (
              <p
                style={{
                  font: 'var(--type-body-sm)',
                  color: 'var(--text-2)',
                  lineHeight: 1.6,
                  marginTop: 'var(--space-4)',
                  paddingTop: 'var(--space-4)',
                  borderTop: '1px solid var(--rule-1)',
                }}
              >
                {result.summary}
              </p>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
};

export default OverviewView;
