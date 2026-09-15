/**
 * The demonstration reading.
 *
 * Every surface that shows sample data quotes this one reading, so the numbers
 * can never contradict each other. Nothing here is typed twice: the size of the
 * set comes from DEFAULT_UNBRANDED_TARGET and the engines come from
 * deployedEngines() — the two constants the product itself runs on.
 *
 * R2.10.1. This block used to state the arithmetic as fact — "36 unbranded
 * questions, 12 put to each engine ... AI Overview 5/12 · ChatGPT 6/12 ·
 * Perplexity 4/12" — after the landing page had already moved to 30 and to the
 * engines this deployment actually probes. One click from a hero reading
 * "Google AI Overview and Perplexity ... 30 unbranded questions", the sample
 * report claimed 36 tracked prompts with a third of them attributed to ChatGPT,
 * an engine this deployment has no API key for. A comment asking a human to
 * keep two files in step is not a mechanism. src/lib/landingHonesty.test.mjs
 * asserts it instead, and this module throws on load if the set stops matching
 * the constant a scan actually runs on.
 *
 * The reading, as derived:
 *   DEFAULT_UNBRANDED_TARGET unbranded questions, split evenly across
 *   deployedEngines() — never an engine this deployment cannot probe
 *   SAMPLE_DESTINATIONS: how those answers land, which is the same array the
 *   landing page donut renders (src/app/page.js)
 *   64 sources cited, 6 of them yours
 *   the rivals in `competitors`, discovered from the answers
 *
 * Every brand here is fictional and must stay recognisably so. There are no
 * real customers, logos, testimonials or case studies anywhere in this file.
 */

import { DEFAULT_UNBRANDED_TARGET } from '../lib/scoring/promptSetSize.js';
import { ENGINE_LABELS, deployedEngines } from '../lib/engines/deployedEngines.js';
import { ROSTER_SOURCE } from '../lib/scoring/rosterContinuity.js';

const YOU = 'you';
const R1 = 'r1';   /* NorthPeak */
const R2 = 'r2';   /* Lumen IQ  */
const NONE = 'none';

const RIVAL_NAME = { [R1]: 'NorthPeak', [R2]: 'Lumen IQ' };
const RIVAL_DOMAIN = { [R1]: 'northpeak.com', [R2]: 'lumeniq.ai' };

/* One registry of engine labels for the whole product. A second copy lived
   here, which is part of how the sample came to name ChatGPT on a deployment
   that has no OPENAI_API_KEY. */
const ENGINE_LABEL = ENGINE_LABELS;

/* The engines this deployment actually probes. Hardcoding aio/chatgpt/
   perplexity here put a third of the sample set behind an engine that never
   ran — the same overclaim this task removed from the hero. */
const ENGINE_KEYS = deployedEngines();

if (ENGINE_KEYS.length === 0) {
  /* Unreachable through deployedEngines(), which falls back to "aio". If it
     ever becomes reachable, a sample carrying `engine: undefined` on every row
     is worse than no sample, because it still looks like a reading. */
  throw new Error(
    'mockData: deployedEngines() returned no engines, so the demonstration '
    + 'reading cannot attribute an answer to anything.',
  );
}

/* The tracked set. Questions a buyer would actually type; none of them names a
   vendor, because a leading question returns a flattering answer.
 *
 * THE ENGINE IS NOT STORED HERE. These questions are engine-agnostic — a real
 * scan puts the set to whatever engines are enabled — so the engine is assigned
 * at build time from deployedEngines(). Storing it made the sample assert a
 * deployment fact it had no way to know.
 *
 * `won` is which brand that answer recommended. The nine `high` questions a
 * rival took are the "high-intent lost" figure. */
const SET = [
  { q: 'best EHR platform for a 200-bed hospital', won: R1, topic: 'Platform selection', intent: 'high' },
  { q: 'how do mid-size hospitals cut readmission rates', won: YOU, topic: 'Clinical outcomes', intent: 'high' },
  { q: 'which analytics tools track clinical outcomes', won: R2, topic: 'Clinical analytics', intent: 'high' },
  { q: 'NABH compliance software comparison', won: R1, topic: 'Compliance', intent: 'high' },
  { q: 'affordable HIMS for multi-specialty clinics', won: NONE, topic: 'Platform selection', intent: 'medium' },
  { q: 'hospital dashboards for length-of-stay reporting', won: YOU, topic: 'Clinical analytics', intent: 'medium' },
  { q: 'electronic prescribing systems for Indian hospitals', won: YOU, topic: 'Platform selection', intent: 'medium' },
  { q: 'how to benchmark clinical quality metrics', won: R1, topic: 'Clinical analytics', intent: 'high' },
  { q: 'ICU capacity planning software', won: R1, topic: 'Operations', intent: 'medium' },
  { q: 'patient no-show reduction tools', won: R2, topic: 'Patient engagement', intent: 'medium' },
  { q: 'hospital inventory management best practices', won: YOU, topic: 'Operations', intent: 'low' },
  { q: 'top patient engagement software in India', won: YOU, topic: 'Patient engagement', intent: 'high' },
  { q: 'vendors for hospital revenue cycle automation', won: YOU, topic: 'Revenue cycle', intent: 'high' },
  { q: 'which platform is best for readmission tracking', won: YOU, topic: 'Clinical outcomes', intent: 'high' },
  { q: 'clinical decision support tools comparison', won: R1, topic: 'Clinical analytics', intent: 'high' },
  { q: 'hospital software for NABH accreditation reporting', won: R1, topic: 'Compliance', intent: 'high' },
  { q: 'teleconsultation platforms for tier-2 cities', won: YOU, topic: 'Telehealth', intent: 'medium' },
  { q: 'best outcome dashboards for private hospitals', won: YOU, topic: 'Clinical analytics', intent: 'medium' },
  { q: 'how do hospitals measure length of stay', won: R1, topic: 'Clinical analytics', intent: 'medium' },
  { q: 'nursing rostering software for hospitals', won: R2, topic: 'Operations', intent: 'medium' },
  { q: 'tools to track infection control indicators', won: R2, topic: 'Clinical outcomes', intent: 'medium' },
  { q: 'what does a hospital data warehouse cost', won: YOU, topic: 'Platform selection', intent: 'low' },
  { q: 'best software to compare hospital outcomes', won: R1, topic: 'Clinical analytics', intent: 'high' },
  { q: 'which vendors handle multi-site hospital reporting', won: R1, topic: 'Platform selection', intent: 'high' },
  { q: 'analytics platforms used by Indian hospital chains', won: YOU, topic: 'Clinical analytics', intent: 'high' },
  { q: 'how to shorten emergency department wait times', won: YOU, topic: 'Operations', intent: 'medium' },
  { q: 'patient feedback platforms for hospitals', won: R2, topic: 'Patient engagement', intent: 'medium' },
  { q: 'software for hospital quality audits', won: R1, topic: 'Compliance', intent: 'high' },
  { q: 'best way to track surgical outcomes', won: YOU, topic: 'Clinical outcomes', intent: 'medium' },
  { q: 'discharge summary automation tools', won: NONE, topic: 'Operations', intent: 'low' },
];

if (SET.length !== DEFAULT_UNBRANDED_TARGET) {
  /* Fail on load, not on render. The previous version of this file held 36
     questions while a scan tracked 30 and the landing page advertised 30, and
     nothing anywhere said so. */
  throw new Error(
    `mockData: the demonstration set holds ${SET.length} questions but a scan `
    + `tracks ${DEFAULT_UNBRANDED_TARGET}. The sample report is one click from `
    + `the landing page; the two may not disagree.`,
  );
}

/* Round-robin, so every deployed engine gets an equal share of the set. */
const engineFor = (i) => ENGINE_KEYS[i % ENGINE_KEYS.length];

/* Where the answers land. The landing page donut renders THIS array rather
   than a second copy of the same four numbers — the second copy is what let
   the page move to 13/10/5/2 while the sample report stayed on 15/12/6/3. */
export const SAMPLE_DESTINATIONS = [
  { key: YOU, label: 'Brightwave', answers: SET.filter((s) => s.won === YOU).length, isYou: true },
  { key: R1, label: RIVAL_NAME[R1], answers: SET.filter((s) => s.won === R1).length },
  { key: R2, label: RIVAL_NAME[R2], answers: SET.filter((s) => s.won === R2).length },
  { key: NONE, label: 'No brand named', answers: SET.filter((s) => s.won === NONE).length, muted: true },
];

/* Sources the engines drew on. Six of the sixty-four are pages you control:
   58 third-party references plus 6 of yours. */
const OWN_PATHS = ['/outcomes', '/platform', '/nabh-reporting', '/readmissions', '/integrations', '/sizing'];
const THIRD_PARTY = [
  'nabh.co', 'healthcareitnews.com', 'expresshealthcare.in', 'who.int',
  'nejm.org', 'himss.org', 'pubmed.ncbi.nlm.nih.gov', 'nhp.gov.in',
  'medicaldialogues.in', 'thelancet.com', 'ihf-fih.org', 'bmj.com',
];
const THIRD_PARTY_TOTAL = 58;

/* Six winning answers cite a page you control, spread across the winning rows.
   Derived rather than a hardcoded list of indices: the old list pointed at row
   35 of a set that is now thirty rows long, and would have cited nothing. */
const WINNING_ROWS = SET.map((item, i) => (item.won === YOU ? i : -1)).filter((i) => i >= 0);
const OWN_CITED_AT = OWN_PATHS.map(
  (_, k) => WINNING_ROWS[Math.floor((k * WINNING_ROWS.length) / OWN_PATHS.length)],
);

/* A rival's own domain is cited on every other answer it took. Keyed off the
   rows it won rather than off row parity, which under a round-robin engine
   assignment would have parked every rival citation on one engine. The rival
   citation counts in `competitors` are then COUNTED off these rows: Lumen IQ
   used to be published with five citations while nothing ever cited it. */
const RIVAL_CITED_AT = new Map(
  [R1, R2].map((key) => [
    RIVAL_NAME[key],
    SET.map((item, i) => (item.won === key ? i : -1)).filter((i) => i >= 0).filter((_, k) => k % 2 === 0),
  ]),
);
const citedRivalsAt = (i) => [...RIVAL_CITED_AT].filter(([, rows]) => rows.includes(i)).map(([nm]) => nm);

function answerText(won, question, brand) {
  if (won === NONE) {
    return `Hospitals evaluating this usually weigh three things: how the data is captured at the point of care, whether reporting maps to the standard they are accredited against, and what the integration burden looks like on the systems already in place. For "${question}" no single vendor is consistently recommended — the answer depends heavily on bed count and the existing EHR.`;
  }
  if (won === YOU) {
    return `For "${question}", ${brand} is the platform named most often, largely on the strength of its outcome dashboards and readmission tracking. Implementation partners tend to prefer it where clinical analytics matter more than billing workflow. ${RIVAL_NAME[R1]} is mentioned as the alternative for hospitals that lead with revenue cycle.`;
  }
  return `For "${question}", ${RIVAL_NAME[won]} is the most frequently recommended platform, largely on the strength of its NABH-aligned reporting and its footprint among Indian implementation partners. ${brand} is not named in this answer; hospitals looking specifically at clinical analytics are usually pointed to a separate tool.`;
}

function buildRows(brand, site) {
  let thirdPartyLeft = THIRD_PARTY_TOTAL;

  return SET.map((item, i) => {
    const mine = item.won === YOU;
    const cited = mine && OWN_CITED_AT.includes(i);
    const rivals = item.won === R1 || item.won === R2 ? [RIVAL_NAME[item.won]] : [];

    /* Spend the third-party budget so the last rows still get their share
       rather than it running out early. */
    const rowsLeft = SET.length - i;
    const refCount = thirdPartyLeft - rowsLeft >= 1 && item.won !== NONE ? 2 : 1;
    thirdPartyLeft -= refCount;

    const refs = [];
    for (let k = 0; k < refCount; k += 1) {
      const domain = THIRD_PARTY[(i * 2 + k) % THIRD_PARTY.length];
      refs.push({ href: `https://${domain}`, source: domain, domain, title: item.topic });
    }
    if (cited) {
      const path = OWN_PATHS[OWN_CITED_AT.indexOf(i)];
      refs.unshift({
        href: `https://${site}${path}`, source: site, domain: site,
        title: `${brand} — ${item.topic}`,
      });
    }

    const text = answerText(item.won, item.q, brand);
    const r1Won = item.won === R1;
    const r2Won = item.won === R2;
    const brands = [
      {
        name: brand,
        is_self: true,
        isSelf: true,
        mentioned: mine,
        position: mine ? 1 : null,
        sentiment: mine ? 1 : null,
      },
      {
        name: RIVAL_NAME[R1],
        is_self: false,
        isSelf: false,
        mentioned: r1Won,
        position: r1Won ? 1 : null,
        sentiment: r1Won ? 1 : null,
      },
      {
        name: RIVAL_NAME[R2],
        is_self: false,
        isSelf: false,
        mentioned: r2Won,
        position: r2Won ? 1 : null,
        sentiment: r2Won ? 1 : null,
      },
    ];

    return {
      prompt: item.q,
      engine: engineFor(i),
      topic: item.topic,
      intent_tier: item.intent,
      source: 'category_seed',
      is_branded_query: false,
      aio_present: true,
      answer_present: true,
      text,
      aio_text: text,
      references: refs,
      aio_references: refs,
      citations: refs,
      aio_citations: refs,
      brand_mentioned_in_text: mine,
      brand_cited: cited,
      visible: mine,
      competitors_found_in_text: rivals,
      competitors_cited: citedRivalsAt(i),
      brands,
      error: null,
      cost: 0,
    };
  });
}

function buildTopDomains(site, rows) {
  const counts = new Map();
  rows.forEach((r) => {
    r.aio_references.forEach((ref) => {
      counts.set(ref.domain, (counts.get(ref.domain) || 0) + 1);
    });
  });
  /* Rival domains the engines reached for, counted from the answers. The
     comment already claimed they were counted; the figures were typed. */
  const rivalDomains = {};
  SET.forEach((item) => {
    const domain = RIVAL_DOMAIN[item.won];
    if (domain) rivalDomains[domain] = (rivalDomains[domain] || 0) + 1;
  });
  Object.entries(rivalDomains).forEach(([d, n]) => counts.set(d, n));

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([domain, count]) => ({
      domain,
      count,
      type: domain === site ? 'brand' : rivalDomains[domain] ? 'competitor' : 'other',
    }));
}

export function buildMockResult(brand, website) {
  const name = brand || 'Brightwave';
  const site = website || 'brightwave.io';
  const rows = buildRows(name, site);
  const topDomains = buildTopDomains(site, rows);

  const total = rows.length;                               /* DEFAULT_UNBRANDED_TARGET */
  const wins = rows.filter((r) => r.visible).length;
  const held = (key) => SET.filter((s) => s.won === key).length;
  const citedBy = (nm) => rows.filter((r) => (r.competitors_cited || []).includes(nm)).length;

  const perEngine = {};
  ENGINE_KEYS.forEach((k) => {
    const of = rows.filter((r) => r.engine === k);
    const totalQ = of.length;
    const withAnswer = of.filter((r) => r.answer_present);
    const nonBranded = of.filter((r) => !r.is_branded_query);
    const nonBrandedWithAnswer = nonBranded.filter((r) => r.answer_present);
    const eliciting = nonBrandedWithAnswer.filter((r) => (r.brands || []).some((b) => b && b.mentioned));
    const dead = nonBrandedWithAnswer.length - eliciting.length;
    const visibleCount = of.filter((r) => r.visible).length;
    const answeredCount = of.length;

    let selfMentions = 0;
    let allMentions = 0;
    const rivalMentionsMap = new Map();
    for (const r of eliciting) {
      for (const b of r.brands || []) {
        if (!b || !b.mentioned) continue;
        allMentions += 1;
        if (b.is_self ?? b.isSelf) {
          selfMentions += 1;
        } else if (b.name) {
          rivalMentionsMap.set(b.name, (rivalMentionsMap.get(b.name) || 0) + 1);
        }
      }
    }

    const topRivals = [...rivalMentionsMap.entries()]
      .map(([nm, count]) => ({
        name: nm,
        mentions: count,
        share_pct: allMentions > 0 ? Math.round((count / allMentions) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.mentions - a.mentions);

    const sovPct = allMentions > 0 ? Math.round((selfMentions / allMentions) * 1000) / 10 : null;
    const visibilityPct = eliciting.length > 0 ? Math.round((visibleCount / eliciting.length) * 1000) / 10 : 0;
    const elicitationRatePct = nonBrandedWithAnswer.length > 0
      ? Math.round((eliciting.length / nonBrandedWithAnswer.length) * 1000) / 10
      : 0;
    const presenceRatePct = totalQ > 0
      ? Math.round((of.filter((r) => r.brand_mentioned_in_text).length / totalQ) * 1000) / 10
      : 0;

    perEngine[k] = {
      engine: k,
      total_queries: totalQ,
      branded_queries: 0,
      non_branded_queries: nonBranded.length,
      queries_with_answer: withAnswer.length,
      non_branded_with_answer: nonBrandedWithAnswer.length,
      branded_with_answer: 0,
      errored_queries: 0,
      eliciting_queries: eliciting.length,
      dead_prompts: dead,
      elicitation_rate_pct: elicitationRatePct,
      share_of_voice_pct: sovPct,
      self_mentions: selfMentions,
      total_brand_mentions: allMentions,
      top_rivals: topRivals,
      visible_non_branded: visibleCount,
      visible_branded: 0,
      mentioned_non_branded: of.filter((r) => r.brand_mentioned_in_text).length,
      cited_non_branded: of.filter((r) => r.brand_cited).length,
      citation_denominator: totalQ,
      citations_unverified_count: 0,
      rank_not_cited_count: 0,
      coverage_pct: 100,
      error_rate_pct: 0,
      share_of_ai_pct: visibilityPct,
      visibility_pct: visibilityPct,
      state: 'measured',
      state_reason: null,
      presence_rate_pct: presenceRatePct,
      data_source_issue: false,
      insufficient_sample: false,

      // Backward compatibility for existing landing / gauge consumers
      visible: visibleCount,
      answered: answeredCount,
    };
  });

  /* The headline is the row counts, rounded once. It used to be typed as 41
     under a comment explaining why it disagreed with its own data. */
  const share = Math.round((wins / total) * 100);

  const totalSelfMentions = Object.values(perEngine).reduce((sum, e) => sum + e.self_mentions, 0);
  const totalBrandMentions = Object.values(perEngine).reduce((sum, e) => sum + e.total_brand_mentions, 0);
  const scanSovPct = totalBrandMentions > 0
    ? Math.round((totalSelfMentions / totalBrandMentions) * 1000) / 10
    : null;

  const rivals = [
    { name: RIVAL_NAME[R1], mentions: held(R1), prompts: held(R1), citations: citedBy(RIVAL_NAME[R1]), userAbsent: true },
    { name: RIVAL_NAME[R2], mentions: held(R2), prompts: held(R2), citations: citedBy(RIVAL_NAME[R2]), userAbsent: true },
    /* The long tail: co-mentioned in the answers rather than winning them. */
    { name: 'Vantage Health', mentions: 4, prompts: 3, citations: 2, userAbsent: false },
    { name: 'Coreset', mentions: 3, prompts: 2, citations: 1, userAbsent: false },
    { name: 'Pulse Metrics', mentions: 2, prompts: 2, citations: 1, userAbsent: true },
    { name: 'Echelon Care', mentions: 2, prompts: 1, citations: 0, userAbsent: false },
    { name: 'Meridian HIS', mentions: 1, prompts: 1, citations: 0, userAbsent: true },
  ].map((r) => ({
    ...r,
    /* One rule for all seven. Two rivals with the same mention count used to
       carry different scores, 6 and 3, against a denominator of 36. */
    visibilityScore: Math.round((r.mentions / total) * 100),
    source: 'discovered',
  }));

  return {
    brand: name,
    website: site,

    visibilityScore: share,
    visibility_pct: share,
    share_of_ai_pct: share,
    visibility_index_pct: share,
    presence_rate_pct: share,
    aio_coverage_pct: 100,
    aio_error_rate_pct: 0,
    brand_citation_share_pct: Math.round((rows.filter((r) => r.brand_cited).length / total) * 100),

    // Real scan SOV and roster fields (R2.7.7)
    share_of_voice_pct: scanSovPct,
    shareOfVoicePct: scanSovPct,
    self_mentions: totalSelfMentions,
    total_brand_mentions: totalBrandMentions,
    rosterSource: ROSTER_SOURCE.EXTRACTED,
    roster_source: ROSTER_SOURCE.EXTRACTED,

    summary_stats: {
      share_of_voice_pct: scanSovPct,
      visibility_pct: share,
      presence_rate_pct: share,
      coverage_pct: 100,
      error_rate_pct: 0,
    },

    promptsAnalyzed: total,
    promptsTracked: total,
    competitorsFound: rivals.length,
    scanTimestamp: new Date().toISOString(),
    scoringVersion: 'demo-1',

    /* `engines` is what flips the shell into multi-engine index mode. */
    engines: perEngine,
    engineScores: perEngine,
    probeSources: [...ENGINE_KEYS],
    perEngineSummaries: perEngine,

    summary:
      `${name} is named in ${wins} of the ${total} answers the engines returned for its category. `
      + `${RIVAL_NAME[R1]} holds ${held(R1)} of the rest, mostly on NABH-aligned reporting, `
      + `${RIVAL_NAME[R2]} holds ${held(R2)}, and ${held(NONE)} name no vendor at all. The clearest `
      + `opening is bed-count sizing, which every rival-held answer organises itself around.`,

    results: rows,

    topPrompts: SET.map((item, i) => ({
      prompt: item.q,
      topic: item.topic,
      intent: item.intent,
      engine: engineFor(i),
      rank: item.won === YOU ? 1 : '—',
      volume: item.intent === 'high' ? 'High' : item.intent === 'medium' ? 'Medium' : 'Low',
    })),

    topDomains,

    /* Discovered from the answers themselves — never a list you maintain.
       A brand is never its own rival: listing it here produced duplicate
       rows and duplicate React keys in every chart. */
    competitors: rivals,
  };
}

export const SAMPLE_RESULT = buildMockResult('Brightwave', 'brightwave.io');

export { ENGINE_LABEL, SET as DEMO_SET };
