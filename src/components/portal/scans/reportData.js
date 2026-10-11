/**
 * Defensive readers for the scan payloads. Every field can be null, missing,
 * or in a shape the worker does not document, so nothing here throws and
 * nothing turns an unknown into a number.
 */

const ENGINE_LABELS = {
  google_ai_overview: "Google AI Overviews",
  aio: "Google AI Overviews",
  openai: "ChatGPT",
  chatgpt: "ChatGPT",
  perplexity: "Perplexity",
  gemini: "Gemini",
  claude: "Claude",
};

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 41.6 -> 42; null / NaN -> null. Used for Stat values (Stat renders null as an em dash). */
export function roundedPct(value) {
  const n = finiteNumber(value);
  return n === null ? null : Math.round(n);
}

export function engineLabel(engine) {
  if (!engine) return "Unknown engine";
  const key = String(engine);
  if (ENGINE_LABELS[key]) return ENGINE_LABELS[key];
  return key.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** scans.platform is a free-form string; arrays are joined, anything else is "—". */
export function platformLabel(platform) {
  if (typeof platform === "string" && platform.trim()) {
    return platform.split(/[,+]/).map((part) => engineLabel(part.trim())).join(", ");
  }
  if (Array.isArray(platform) && platform.length) {
    return platform.map((part) => engineLabel(part)).join(", ");
  }
  return "—";
}

/**
 * engine_scores -> [{ name, pct }] sorted high to low. Accepts an object keyed
 * by engine (what aggregate.js writes) or an array of { engine|name, score }.
 * Returns [] when nothing usable is present.
 */
export function readEngineScores(engineScores) {
  const rows = [];
  if (isRecord(engineScores)) {
    Object.entries(engineScores).forEach(([name, value]) => {
      const pct = finiteNumber(value);
      if (pct !== null) rows.push({ name, pct });
    });
  } else if (Array.isArray(engineScores)) {
    engineScores.forEach((item) => {
      if (!isRecord(item)) return;
      const name = item.engine || item.name;
      const pct = finiteNumber(item.score ?? item.value ?? item.pct ?? item.visibility_pct);
      if (name && pct !== null) rows.push({ name: String(name), pct });
    });
  }
  return rows.sort((a, b) => b.pct - a.pct);
}

/** Per-engine slices: engines is an object keyed by engine (or an array with .engine). */
function engineSlices(engines) {
  if (isRecord(engines)) return Object.values(engines).filter(isRecord);
  if (Array.isArray(engines)) return engines.filter(isRecord);
  return [];
}

/**
 * "Who the engines named instead of you", ranked. Mention counts come from the
 * per-engine top_rivals lists; the scan's competitor roster adds names that
 * were never counted. Counts stay null when the scan did not record them.
 * Returns { rows: [{ name, count, isBrand }], hasCounts }.
 */
export function readCompetitors({ competitors, engines, brand }) {
  const totals = new Map();
  const add = (name, count) => {
    const label = typeof name === "string" ? name.trim() : "";
    if (!label) return;
    const key = label.toLowerCase();
    const prev = totals.get(key) || { name: label, count: null };
    const next = finiteNumber(count);
    totals.set(key, {
      name: prev.name,
      count: next === null ? prev.count : (prev.count ?? 0) + next,
    });
  };

  engineSlices(engines).forEach((slice) => {
    if (!Array.isArray(slice.top_rivals)) return;
    slice.top_rivals.forEach((rival) => {
      if (typeof rival === "string") add(rival, null);
      else if (isRecord(rival)) add(rival.name, rival.mentions ?? rival.count);
    });
  });

  if (Array.isArray(competitors)) {
    competitors.forEach((item) => {
      if (typeof item === "string") add(item, null);
      else if (isRecord(item)) add(item.name, item.mentions ?? item.count);
    });
  }

  const brandKey = typeof brand === "string" ? brand.trim().toLowerCase() : "";
  const rows = [...totals.values()].map((row) => ({
    name: row.name,
    count: row.count,
    isBrand: !!brandKey && row.name.toLowerCase() === brandKey,
  }));
  const hasCounts = rows.some((row) => row.count !== null);
  rows.sort((a, b) => {
    if (a.isBrand !== b.isBrand) return a.isBrand ? -1 : 1;
    if (hasCounts) return (b.count ?? -1) - (a.count ?? -1) || a.name.localeCompare(b.name);
    return a.name.localeCompare(b.name);
  });
  return { rows, hasCounts };
}

/** Group prompt_results rows by question text, keeping the engine rows in order. */
export function groupQuestions(results) {
  const groups = new Map();
  (Array.isArray(results) ? results : []).forEach((row) => {
    if (!isRecord(row)) return;
    const query = typeof row.query === "string" && row.query.trim() ? row.query.trim() : "Untitled question";
    if (!groups.has(query)) groups.set(query, { query, rows: [] });
    groups.get(query).rows.push(row);
  });
  return [...groups.values()];
}

/** Does this question count as "naming you" for the chosen engine filter? */
export function questionNamesBrand(question, engine) {
  const rows = engine === "all" ? question.rows : question.rows.filter((row) => row.engine === engine);
  return rows.some((row) => row.mentioned === true);
}

export function engineOptions(results) {
  const names = new Set();
  (Array.isArray(results) ? results : []).forEach((row) => {
    if (isRecord(row) && row.engine) names.add(String(row.engine));
  });
  return [...names].sort().map((name) => ({ value: name, label: engineLabel(name) }));
}
