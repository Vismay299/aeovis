'use client';

/**
 * R2.9.1 — Provenance strip under the hero.
 *
 * A dense, factual row that tells the reader exactly what went into the
 * headline number. Every value is read off the persisted scan record —
 * nothing is recomputed here, because a provenance surface that derives
 * its own numbers defeats its purpose.
 *
 * Fields:
 *   - Engines counted / skipped
 *   - Eliciting pool size and elicitation rate
 *   - Dead prompts
 *   - Prompt-set version
 *   - Geo (when persisted)
 *   - Collection window (already rendered on the topbar; repeated here
 *     under its provenance label for readers who scroll past the bar)
 */

import { formatCollectionWindow } from '@/shared/format';

/**
 * Sum a numeric field across all per-engine slices, returning null when every
 * slice is nullish — a measured 0 is distinct from an unmeasured field.
 */
function sumAcrossEngines(perEngineSummaries, field) {
  if (!perEngineSummaries || typeof perEngineSummaries !== 'object') return null;
  const values = Object.values(perEngineSummaries)
    .map((s) => s?.[field])
    .filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0);
}

/**
 * Compute the aggregate elicitation rate across engines: total eliciting
 * queries divided by total non-branded queries with an answer.  A simple
 * sum of per-engine rates would be mathematically wrong (rates have
 * different denominators).
 */
function computeElicitationRate(perEngineSummaries) {
  if (!perEngineSummaries || typeof perEngineSummaries !== 'object') return null;
  let totalEliciting = 0;
  let totalAnswered = 0;
  let found = false;
  for (const s of Object.values(perEngineSummaries)) {
    const e = s?.eliciting_queries;
    const a = s?.non_branded_with_answer;
    if (typeof e === 'number' && Number.isFinite(e)) {
      totalEliciting += e;
      found = true;
    }
    if (typeof a === 'number' && Number.isFinite(a)) {
      totalAnswered += a;
    }
  }
  if (!found || totalAnswered === 0) return null;
  return (totalEliciting / totalAnswered) * 100;
}

/**
 * The component renders nothing when there is nothing to show — an empty
 * strip is worse than no strip (standing rule 1).
 */
export function ProvenanceStrip({ result }) {
  if (!result) return null;

  const perEngine = result.perEngineSummaries;

  // ── engines counted / skipped ──────────────────────────────────────
  const enginesCounted =
    typeof result.enginesCounted === 'number' && Number.isFinite(result.enginesCounted)
      ? result.enginesCounted
      : null;
  // engines_partial is a list of engines that ran but errored on every
  // prompt; counted but not contributing to the index.
  const enginesPartial = result.enginesPartial;
  const skippedCount = Array.isArray(enginesPartial) ? enginesPartial.length : null;

  // ── eliciting pool & rate ──────────────────────────────────────────
  const elicitingPoolSize = sumAcrossEngines(perEngine, 'eliciting_queries');
  const elicitationRate = computeElicitationRate(perEngine);

  // ── dead prompts ───────────────────────────────────────────────────
  const deadPrompts = sumAcrossEngines(perEngine, 'dead_prompts');

  // ── prompt-set version ─────────────────────────────────────────────
  const promptSetVersion =
    result.promptSetId || result.prompt_set_id || null;

  // ── geo ────────────────────────────────────────────────────────────
  // The worker computes geo but it is not always persisted on the scan
  // record. Render when available, skip silently otherwise.
  const rawResults = result.rawResults || result.raw_results;
  const geo =
    result.geo ??
    result.raw_results?.geo ??
    (typeof rawResults === 'object' && rawResults !== null && !Array.isArray(rawResults)
      ? rawResults.geo
      : null) ??
    null;

  // ── collection window ──────────────────────────────────────────────
  const windowLabel = formatCollectionWindow(result.collectedFrom, result.collectedTo);

  // ── render ─────────────────────────────────────────────────────────
  // Build the list of factual chips; each is rendered only when the value
  // exists, so an older scan with no eliciting data simply omits that chip
  // rather than printing an em dash for it.
  const chips = [];

  if (enginesCounted !== null) {
    const label =
      skippedCount !== null && skippedCount > 0
        ? `${enginesCounted} counted · ${skippedCount} skipped`
        : `${enginesCounted} counted`;
    chips.push({ key: 'engines', label });
  }

  if (elicitingPoolSize !== null) {
    chips.push({
      key: 'eliciting-pool',
      label: `eliciting pool ${elicitingPoolSize}`,
    });
  }

  if (elicitationRate !== null) {
    chips.push({
      key: 'elicitation-rate',
      label: `elicitation ${Math.round(elicitationRate)}%`,
    });
  }

  if (deadPrompts !== null && deadPrompts > 0) {
    chips.push({
      key: 'dead-prompts',
      label: `${deadPrompts} dead prompt${deadPrompts === 1 ? '' : 's'}`,
    });
  }

  if (promptSetVersion) {
    chips.push({
      key: 'prompt-set',
      label: `prompt-set ${promptSetVersion}`,
    });
  }

  if (geo) {
    chips.push({ key: 'geo', label: `geo ${String(geo).toUpperCase()}` });
  }

  if (windowLabel) {
    chips.push({
      key: 'collection-window',
      label: `collected ${windowLabel}`,
    });
  }

  if (chips.length === 0) return null;

  return (
    <div
      className="provenance-strip"
      data-testid="provenance-strip"
      role="group"
      aria-label="Scan provenance"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 6,
        marginTop: 8,
      }}
    >
      {chips.map((c) => (
        <span
          key={c.key}
          className="tag"
          data-testid={`provenance-${c.key}`}
          style={{ fontSize: 12 }}
        >
          {c.label}
        </span>
      ))}
    </div>
  );
}

export default ProvenanceStrip;
