/**
 * Shapes a scan result into the two things every reading surface needs:
 * where each answered question ended up, and how each engine did.
 *
 * Tolerates both the snake_case rows the pipeline writes and the camelCase
 * the API sometimes returns.
 *
 * Extracted from the rejected Signal Box RouteDiagram so the data shaping
 * outlives the visual language it was written for.
 */

const ENGINE_NAMES = {
  google_ai_overview: 'AI Overview',
  aio: 'AI Overview',
  perplexity: 'Perplexity',
  openai: 'ChatGPT',
  chatgpt: 'ChatGPT',
  gemini: 'Gemini',
};

export function engineName(key) {
  return ENGINE_NAMES[key] || String(key || '').replace(/_/g, ' ');
}

export function buildInterlocking(result, { maxRivals = 4 } = {}) {
  const rows = (result?.rawResults || result?.nonBrandedResults || []).filter(
    (r) => !(r.is_branded_query ?? r.isBrandedQuery),
  );

  const answered = rows.filter(
    (r) => r.aio_present || r.aioPresent || r.answer_present || r.answerPresent,
  );

  const yours = answered.filter(
    (r) =>
      (r.brand_mentioned_in_text ?? r.brandMentionedInText) ||
      (r.brand_cited ?? r.brandCited),
  ).length;

  /* Rival occupancy: how many answered questions named each rival while
     saying nothing about you. That is the answer they took from you. */
  const rivalCounts = new Map();
  answered.forEach((r) => {
    const mine =
      (r.brand_mentioned_in_text ?? r.brandMentionedInText) ||
      (r.brand_cited ?? r.brandCited);
    if (mine) return;
    const named = [
      ...(r.competitors_found_in_text || r.competitorsFoundInText || []),
      ...(r.competitors_cited || r.competitorsCited || []),
    ];
    new Set(named).forEach((n) => rivalCounts.set(n, (rivalCounts.get(n) || 0) + 1));
  });

  /* A brand is never its own rival. Scan data occasionally carries the brand
     back in the competitor list; it must not open a second destination. */
  const own = String(result?.brand || '').trim().toLowerCase();
  const isOwn = (name) => own && String(name).trim().toLowerCase() === own;

  /* Fall back to the aggregate competitor table when rows carry no
     per-question rival data. */
  let rivals = [...rivalCounts.entries()]
    .filter(([name]) => !isOwn(name))
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxRivals)
    .map(([name, count]) => ({ key: `rival-${name}`, name, count, isYou: false }));

  if (rivals.length === 0 && Array.isArray(result?.competitors)) {
    const seen = new Set();
    rivals = result.competitors
      .filter((c) => {
        const k = String(c.name).trim().toLowerCase();
        if (!k || isOwn(c.name) || seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, maxRivals)
      .map((c) => ({
        key: `rival-${c.name}`,
        name: c.name,
        count: c.prompts ?? c.mentions ?? 0,
        isYou: false,
      }));
  }

  const nobody = Math.max(0, answered.length - yours - rivals.reduce((s, r) => s + r.count, 0));

  const platforms = [
    { key: 'you', name: result?.brand || 'Your brand', count: yours, isYou: true },
    ...rivals,
    { key: 'nobody', name: 'No brand named', count: nobody, isNobody: true },
  ];

  const total = rows.length || result?.promptsAnalyzed || result?.promptsTracked || 0;

  /* Engines: whatever actually reported, never a hardcoded list.

     R2.8.2 — an engine with zero rows of its own is marked `noData` rather
     than silently inheriting all rows.  Before this fix, `scoped = of.length
     ? of : rows` made a zero-row engine look identical to one that answered
     every prompt, and the fallback at probes/cleared invented counts from the
     whole set — an engine that never ran appeared to report. */
  const engineKeys = Object.keys(result?.engineScores || {});
  const engines = (engineKeys.length ? engineKeys : ['aio']).map((k) => {
    const of = rows.filter((r) => (r.engine || 'aio') === k);
    const hasData = of.length > 0;
    const cleared = hasData
      ? of.filter(
          (r) =>
            (r.brand_mentioned_in_text ?? r.brandMentionedInText) ||
            (r.brand_cited ?? r.brandCited),
        ).length
      : 0;
    return {
      key: k,
      name: engineName(k),
      /* R2.8.2 — no-data engines report zero, not a phantom count. */
      probes: hasData ? of.length : 0,
      cleared,
      noData: !hasData,
    };
  });

  return { engines, platforms, total, answered: answered.length };
}

export default buildInterlocking;
