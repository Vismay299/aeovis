'use client';

/**
 * Answers.
 *
 * The tracked set on the left, the verbatim answer on the right. Selecting a
 * question drives the panel; the panel keeps the engine's own words and marks
 * where your name appears and where a rival took the recommendation.
 *
 * No score without the sentence that produced it — that is what this view is.
 */

import { useMemo, useState } from 'react';
import { Camera, ExternalLink, Link2, Sparkles, Loader2 } from 'lucide-react';
import { engineName } from './interlocking';

/**
 * R1.5.3 — the href behind "View evidence", or null when there is nothing to
 * open. THE predicate for the affordance, exported so it can be tested on its
 * own and so nothing re-derives it by hand.
 *
 * Three things must be true, and all three are about EXISTENCE, never about a
 * fallback:
 *   1. `evidenceScreenshotId` is a non-empty string — the answer has a stored
 *      capture. NULL means no capture was taken; the button then does not exist
 *      at all, because a button that opens a 404 is worse than no button.
 *   2. `resultId` — the prompt_results row the key hangs off.
 *   3. `jobId` — the scan job that row belongs to, which is what the route
 *      scopes the lookup by.
 * Missing (2) or (3) means this row was read through a path that does not carry
 * its identity (older stored scans, sample data), so the link cannot be
 * addressed. It is hidden rather than guessed.
 *
 * The id is NEVER put in the URL as an object key — it is checked here only to
 * decide whether a capture exists. The route reads the key off the row itself.
 */
export function evidenceScreenshotHref(prompt) {
  if (!prompt) return null;
  const hasScreenshot = typeof prompt.evidenceScreenshotId === 'string' && prompt.evidenceScreenshotId.trim() !== '';
  const jobId = typeof prompt.jobId === 'string' ? prompt.jobId.trim() : '';
  const resultId = typeof prompt.resultId === 'string' ? prompt.resultId.trim() : '';
  if (!hasScreenshot || !jobId || !resultId) return null;
  return `/api/scan/${encodeURIComponent(jobId)}/evidence?result=${encodeURIComponent(resultId)}&kind=screenshot`;
}

/* Marks the brand in the engine's text. `mark.lit-you` is the design system's
   own verdict mark, so this reads the same here as it does on the landing. */
function highlightBrand(text, aliases) {
  if (!text || !aliases?.length) return text;
  const sorted = [...aliases].sort((a, b) => b.length - a.length);
  const escaped = sorted.map((a) => a.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'));
  const re = new RegExp(`(^|[^\\w])(${escaped.join('|')})(?=$|[^\\w])`, 'gi');
  const parts = [];
  let lastIndex = 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    parts.push(text.slice(lastIndex, match.index + match[1].length));
    parts.push(<mark key={match.index} className="lit-you">{match[2]}</mark>);
    lastIndex = match.index + match[0].length;
  }
  parts.push(text.slice(lastIndex));
  return parts;
}

/* The verdict a question resolved to, as one chip. */
function VerdictChip({ visible, aioPresent, error, isBranded, engine }) {
  if (error) return <span className="chip chip--crit"><i className="chip__led" /> Error</span>;
  if (!aioPresent) {
    return <span className="chip">{engine && engine !== 'aio' ? 'No answer' : 'No AI Overview'}</span>;
  }
  if (visible) {
    return (
      <span className="chip chip--you">
        You{isBranded ? ' · branded' : ''}
      </span>
    );
  }
  return <span className="chip">Rival held it</span>;
}

/**
 * One row of filter pills. R6.4.12.
 *
 * There were two of these, written out twice with identical markup — the
 * verdict filters and the engine filters — so a change to how a pill reads had
 * two places to land and no guard that it reached both.
 *
 * NOT the same thing as ScoreBand's engine chips, and deliberately not sharing
 * `describeEngineChip` with them. A pill's `count` is
 * `prompts.filter(...).length`: it is ALWAYS a real integer derived from the
 * rows in hand, and a count of 0 is a measured zero. ScoreBand's chip carries a
 * `share_of_ai_pct` that can be genuinely absent, which is the entire reason
 * R2.7.8 gave it an em-dash-plus-state rendering. Routing a count through that
 * formatter would let an always-measured number render as "not measured" — it
 * would manufacture the absence, which is the same lie pointed the other way.
 * The guard in answersEngineFilters.test.mjs asserts this row stays a count row.
 */
function FilterRow({ chips, active, onPick, testid }) {
  return (
    <div className="filters" data-testid={testid}>
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          className={`filter${active === chip.key ? ' is-on' : ''}`}
          onClick={() => onPick(chip.key)}
          data-filter-key={chip.key}
          data-filter-count={chip.count}
        >
          {chip.label} <span style={{ opacity: 0.6 }}>{chip.count}</span>
        </button>
      ))}
    </div>
  );
}

function isGapRow(p) {
  return !p.isBrandedQuery
    && !p.error
    && p.aioPresent
    && (!p.visible || (p.brandMentioned && !p.brandCited));
}

function Verbatim({ prompt, brandAliases, onGenerateContent }) {
  const [generating, setGenerating] = useState(false);

  if (!prompt) {
    return (
      <div className="panel">
        <div className="panel__h"><b>The answer</b></div>
        <div className="blank">
          <h4>Pick a question</h4>
          <p>Select a row to read the answer the engine actually returned, kept verbatim.</p>
        </div>
      </div>
    );
  }

  const label = engineName(prompt.engine || 'aio');
  const gap = isGapRow(prompt);
  const evidenceHref = evidenceScreenshotHref(prompt);

  const handleGenerate = async () => {
    if (generating || !onGenerateContent) return;
    setGenerating(true);
    try {
      await onGenerateContent(prompt);
    } finally {
      setGenerating(false);
    }
  };

  return (
    /* sticky so the answer stays beside the list while it is scrolled */
    <div className="panel" style={{ position: 'sticky', top: 76 }}>
      <div className="panel__h">
        <span className="chip">{label}</span>
        <VerdictChip
          visible={prompt.visible}
          aioPresent={prompt.aioPresent}
          error={prompt.error}
          isBranded={prompt.isBrandedQuery}
          engine={prompt.engine}
        />
        {prompt.brandCited && <span className="chip chip--good">Domain cited</span>}
      </div>
      <div className="panel__b">
        <p
          style={{
            fontSize: 16, fontWeight: 600, color: 'var(--ink-1)', letterSpacing: '-.018em',
            paddingBottom: 14, marginBottom: 14, borderBottom: '1px solid var(--line-soft)',
          }}
        >
          &ldquo;{prompt.prompt}&rdquo;
        </p>

        {/* R1.5.3 — the engine's own screen, behind a signed URL that expires
            (120 s; src/server/evidenceSignedUrl.js). Rendered only when a capture
            was actually stored for this answer: no capture, no button. A plain
            link, so the new tab is a real navigation the browser cannot block
            and the signed URL never touches this page. */}
        {evidenceHref && (
          <p style={{ marginTop: -6, marginBottom: 14 }}>
            <a
              href={evidenceHref}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="view-evidence-link"
              title="Open the stored screenshot of this answer (link expires)"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 7,
                fontSize: 13.5, color: 'var(--brand)', fontWeight: 500,
              }}
            >
              <Camera size={13} aria-hidden="true" />
              View evidence
            </a>
          </p>
        )}

        {prompt.error ? (
          <p style={{ fontSize: 14, color: 'var(--crit)' }}>
            {label} returned an error for this query: {prompt.error}
          </p>
        ) : prompt.aioPresent ? (
          <p
            style={{
              fontSize: 15.5, lineHeight: 1.8, color: 'var(--ink-2)', whiteSpace: 'pre-line',
            }}
          >
            {highlightBrand(prompt.aioText, brandAliases)}
          </p>
        ) : (
          <p style={{ fontSize: 14, color: 'var(--ink-3)' }}>
            {label} returned no answer for this question in this reading.
          </p>
        )}

        {prompt.competitorsFound?.length > 0 && (
          <div className="sheet__foot">
            <span className="tag">Also named</span>
            {prompt.competitorsFound.map((c) => (
              <span key={c} className="chip">{c}</span>
            ))}
          </div>
        )}

        {prompt.aioReferences?.length > 0 && (
          <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--line-soft)' }}>
            <div className="tag" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
              <Link2 size={12} aria-hidden="true" /> Sources ({prompt.aioReferences.length})
            </div>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 7 }}>
              {prompt.aioReferences.map((ref, i) => (
                <li key={i}>
                  <a
                    href={ref.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 7,
                      fontSize: 13.5, color: 'var(--brand)',
                    }}
                  >
                    <ExternalLink size={12} aria-hidden="true" />
                    <span style={{ fontWeight: 500 }}>{ref.source || ref.domain || 'source'}</span>
                    {ref.title && <span className="dim"> — {ref.title}</span>}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}

        {gap && onGenerateContent && (
          <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--line-soft)' }}>
            <button
              type="button"
              data-testid="generate-content-btn"
              className="btn btn--primary btn--sm"
              onClick={handleGenerate}
              disabled={generating}
              title="Start a content run targeting this gap"
            >
              {generating
                ? <Loader2 size={13} aria-hidden="true" />
                : <Sparkles size={13} aria-hidden="true" />}
              {generating ? 'Starting…' : 'Write for this gap'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export const AnswersView = ({
  prompts = [],
  brandAliases = [],
  title = 'Non-branded queries',
  subtitle,
  emptyLabel = 'No queries yet.',
  onGenerateContent,
  ...rest
}) => {
  const [filter, setFilter] = useState('all');
  const [engineFilter, setEngineFilter] = useState('all');
  const [selected, setSelected] = useState(0);

  const hasEngines = prompts.some((p) => p.engine);

  // R2.7.17 — THE ONE RULE for whether a visible row counts under "Names you":
  // an errored row's VerdictChip renders "Error", so counting it under a
  // positive label creates a contradiction on the same screen. Every consumer
  // that reads `visible` for aggregation (chip counts, filters, lift) must
  // gate on `!p.error`. The ROW itself stays honest — visible = true on an
  // errored-but-cited row is correct (probeResultContract.js:397 enforces the
  // identity) — but a count that includes it under "Names you" contradicts
  // the row's own VerdictChip.
  const filtered = useMemo(() => prompts.filter((p) => {
    if (engineFilter !== 'all' && (p.engine || 'aio') !== engineFilter) return false;
    if (filter === 'visible') return p.visible && !p.error;
    if (filter === 'absent') return !!p.aioPresent && !p.visible && !p.error;
    if (filter === 'no-aio') return !p.aioPresent && !p.error;
    if (filter === 'cited') return !!p.brandCited && !p.error;
    return true;
  }), [prompts, filter, engineFilter]);

  const filterChips = [
    { key: 'all', label: 'All', count: prompts.length },
    // R2.7.17 — exclude errored rows so chip count agrees with VerdictChip
    { key: 'visible', label: 'Names you', count: prompts.filter((p) => p.visible && !p.error).length },
    { key: 'absent', label: 'Rival held it', count: prompts.filter((p) => !!p.aioPresent && !p.visible && !p.error).length },
    { key: 'no-aio', label: hasEngines ? 'No answer' : 'No AIO', count: prompts.filter((p) => !p.aioPresent && !p.error).length },
    { key: 'cited', label: 'Cited you', count: prompts.filter((p) => !!p.brandCited && !p.error).length },
  ];

  /* Engine pills come from what the scan reported, never a fixed list.
     Named `engineFilters`, not `engineChips`: `engineChips` is ScoreBand's
     measurement row and means something else entirely (see FilterRow). */
  const engineFilters = useMemo(() => {
    if (!hasEngines) return null;
    const keys = [...new Set(prompts.map((p) => p.engine || 'aio'))];
    return [
      { key: 'all', label: 'All engines', count: prompts.length },
      ...keys.map((k) => ({
        key: k,
        label: engineName(k),
        count: prompts.filter((p) => (p.engine || 'aio') === k).length,
      })),
    ];
  }, [prompts, hasEngines]);

  const current = filtered[Math.min(selected, filtered.length - 1)] || null;

  return (
    <div className="grid g-side" {...rest}>
      <div className="panel">
        <div className="panel__h">
          <b>{title}</b>
          <span className="tag">
            {filtered.length === prompts.length
              ? `${prompts.length} tracked`
              : `${filtered.length} of ${prompts.length} shown`}
          </span>
        </div>

        <div className="panel__b" style={{ paddingBottom: 4 }}>
          {subtitle && (
            <p style={{ fontSize: 13.5, color: 'var(--ink-3)', marginBottom: 14 }}>{subtitle}</p>
          )}
          <FilterRow
            testid="answers-verdict-filters"
            chips={filterChips}
            active={filter}
            onPick={(key) => { setFilter(key); setSelected(0); }}
          />
          {engineFilters && engineFilters.length > 2 && (
            <FilterRow
              testid="answers-engine-filters"
              chips={engineFilters}
              active={engineFilter}
              onPick={(key) => { setEngineFilter(key); setSelected(0); }}
            />
          )}
        </div>

        <div className="panel__b panel__b--flush" style={{ borderTop: '1px solid var(--line-soft)' }}>
          {filtered.length === 0 ? (
            <div className="blank"><p>{emptyLabel}</p></div>
          ) : (
            filtered.map((p, i) => (
              <button
                key={`${p.prompt}-${p.engine || 'aio'}-${i}`}
                type="button"
                data-testid="aio-evidence-row"
                className={`qrow${i === selected ? ' is-sel' : ''}`}
                onClick={() => setSelected(i)}
                aria-current={i === selected ? 'true' : undefined}
              >
                <span className="qrow__i">Q{String(i + 1).padStart(2, '0')}</span>
                <span className="qrow__q">{p.prompt}</span>
                <span className="qrow__e">{engineName(p.engine || 'aio')}</span>
                <span className="qrow__v">
                  <VerdictChip
                    visible={p.visible}
                    aioPresent={p.aioPresent}
                    error={p.error}
                    isBranded={p.isBrandedQuery}
                    engine={p.engine}
                  />
                </span>
              </button>
            ))
          )}
        </div>
      </div>

      <Verbatim
        prompt={current}
        brandAliases={brandAliases}
        onGenerateContent={onGenerateContent}
      />
    </div>
  );
};

export default AnswersView;
