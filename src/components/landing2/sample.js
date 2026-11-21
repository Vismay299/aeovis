/**
 * Every figure the new landing page shows, derived — never typed.
 *
 * The page quotes ONE demonstration reading: the sample report in
 * src/shared/mockData.js. Counts are computed from its rows, the question set
 * size comes from DEFAULT_UNBRANDED_TARGET, and engine names come from
 * deployedEngines(). Brightwave, NorthPeak and Lumen IQ are fictional and the
 * page labels every surface that shows them as a sample.
 *
 * No number here is seeded, randomised or clocked. If a value cannot be read
 * from the sample it is left out, not filled with a zero.
 */

import { SAMPLE_RESULT, SAMPLE_DESTINATIONS, DEMO_SET } from "@/shared/mockData";
import { DEFAULT_UNBRANDED_TARGET } from "@/shared/scoring/promptSetSize";
import { deployedEngineLabels, formatEngineList } from "@/shared/engines/deployedEngines";

export const ENGINE_NAMES = deployedEngineLabels();
export const ENGINE_SENTENCE_LIST = formatEngineList(ENGINE_NAMES);
export const QUESTION_COUNT = DEFAULT_UNBRANDED_TARGET;

export const BRAND = SAMPLE_RESULT.brand;
export const SHARE = SAMPLE_RESULT.visibilityScore;
export const TRACKED = SAMPLE_RESULT.promptsTracked;
export const ROWS = SAMPLE_RESULT.results;
export const WINS = ROWS.filter((r) => r.visible).length;

/* The four places an answer can land, in the sample report's own order. */
export const DESTINATIONS = SAMPLE_DESTINATIONS.map((d) => ({
  key: d.key,
  label: d.label,
  answers: d.answers,
  isYou: Boolean(d.isYou),
  muted: Boolean(d.muted),
}));

/* Which destination each question resolved to, by the sample set's own `won`. */
export const QUESTIONS = DEMO_SET.map((item, i) => ({
  id: `q${i}`,
  q: item.q,
  topic: item.topic,
  intent: item.intent,
  won: item.won,
}));

/* Rival standings: you plus the discovered rivals, by mentions. */
export const STANDINGS = [
  { name: BRAND, mentions: WINS, isYou: true },
  ...SAMPLE_RESULT.competitors.map((c) => ({ name: c.name, mentions: c.mentions, isYou: false })),
]
  .sort((a, b) => b.mentions - a.mentions)
  .slice(0, 5);

/* Sources the engines cited, counted from the answers themselves: every
   reference an answer carried, and the answers that cited a page you control.
   The bar and list below them come from the report's domain table. */
export const CITATIONS_TOTAL = ROWS.reduce((sum, r) => sum + (r.aio_references || []).length, 0);
export const CITATIONS_YOURS = ROWS.filter((r) => r.brand_cited).length;
export const TOP_DOMAINS = SAMPLE_RESULT.topDomains.slice(0, 8);

/* Three verbatim answers from the sample: one you won, one a rival won, one
   that named nobody. Text, citations and named brands come off the row. */
function pick(won) {
  const index = DEMO_SET.findIndex((s) => s.won === won);
  if (index < 0) return null;
  const row = ROWS[index];
  return {
    won,
    question: row.prompt,
    text: row.text,
    citations: (row.citations || []).map((c) => c.domain),
    named: (row.brands || []).filter((b) => b.mentioned).map((b) => b.name),
    engine: row.engine,
  };
}

export const EVIDENCE = [pick("you"), pick("r1"), pick("none")].filter(Boolean);

/* The unbranded question used in the "ask about yourself" demonstration:
   the first one a rival took. Its answer is the sample row, verbatim. */
export const UNBRANDED_EXAMPLE = pick("r2");

/* Names to mark up in answer text, and how. */
export const RIVAL_NAMES = SAMPLE_RESULT.competitors.map((c) => c.name);

/* The rival with the most answers, for the hero copy. */
export const TOP_RIVAL = DESTINATIONS.find((d) => !d.isYou && !d.muted);
