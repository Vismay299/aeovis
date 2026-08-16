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
import { ExternalLink, Link2, Sparkles, Loader2 } from 'lucide-react';
import { engineName } from './interlocking';

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

  const filtered = useMemo(() => prompts.filter((p) => {
    if (engineFilter !== 'all' && (p.engine || 'aio') !== engineFilter) return false;
    if (filter === 'visible') return p.visible;
    if (filter === 'absent') return !!p.aioPresent && !p.visible;
    if (filter === 'no-aio') return !p.aioPresent && !p.error;
    if (filter === 'cited') return !!p.brandCited;
    return true;
  }), [prompts, filter, engineFilter]);

  const filterChips = [
    { key: 'all', label: 'All', count: prompts.length },
    { key: 'visible', label: 'Names you', count: prompts.filter((p) => p.visible).length },
    { key: 'absent', label: 'Rival held it', count: prompts.filter((p) => !!p.aioPresent && !p.visible).length },
    { key: 'no-aio', label: hasEngines ? 'No answer' : 'No AIO', count: prompts.filter((p) => !p.aioPresent && !p.error).length },
    { key: 'cited', label: 'Cited you', count: prompts.filter((p) => !!p.brandCited).length },
  ];

  /* Engine pills come from what the scan reported, never a fixed list. */
  const engineChips = useMemo(() => {
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
          <div className="filters">
            {filterChips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                className={`filter${filter === chip.key ? ' is-on' : ''}`}
                onClick={() => { setFilter(chip.key); setSelected(0); }}
              >
                {chip.label} <span style={{ opacity: 0.6 }}>{chip.count}</span>
              </button>
            ))}
          </div>
          {engineChips && engineChips.length > 2 && (
            <div className="filters">
              {engineChips.map((chip) => (
                <button
                  key={chip.key}
                  type="button"
                  className={`filter${engineFilter === chip.key ? ' is-on' : ''}`}
                  onClick={() => { setEngineFilter(chip.key); setSelected(0); }}
                >
                  {chip.label} <span style={{ opacity: 0.6 }}>{chip.count}</span>
                </button>
              ))}
            </div>
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
