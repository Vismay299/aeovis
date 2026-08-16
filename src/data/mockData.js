/**
 * The demonstration reading.
 *
 * Every surface that shows sample data quotes this one reading, so the numbers
 * can never contradict each other:
 *
 *   36 unbranded questions, 12 put to each engine
 *   15 answers name you · 12 NorthPeak · 6 Lumen IQ · 3 name no brand
 *   AI Overview 5/12 · ChatGPT 6/12 · Perplexity 4/12
 *   64 sources cited, 6 of them yours · 9 high-intent answers lost
 *   7 rivals discovered
 *
 * 15 + 12 + 6 + 3 = 36. Change one of these and change all of them.
 *
 * Every brand here is fictional and must stay recognisably so. There are no
 * real customers, logos, testimonials or case studies anywhere in this file.
 */

const YOU = 'you';
const R1 = 'r1';   /* NorthPeak */
const R2 = 'r2';   /* Lumen IQ  */
const NONE = 'none';

const RIVAL_NAME = { [R1]: 'NorthPeak', [R2]: 'Lumen IQ' };
const ENGINE_LABEL = { aio: 'Google AI Overview', chatgpt: 'ChatGPT', perplexity: 'Perplexity' };
const ENGINE_KEYS = ['aio', 'chatgpt', 'perplexity'];

/* The tracked set. Thirty-six questions a buyer would actually type, twelve
   put to each engine. None of them names a vendor — a leading question
   returns a flattering answer, so the set never contains one.
 *
 * `won` is which brand that answer recommended. The nine `high` questions a
 * rival took are the "high-intent lost" figure. */
const SET = [
  /* ── Google AI Overview ─────────────────────────────────────────── */
  { q: 'best EHR platform for a 200-bed hospital', e: 'aio', won: R1, topic: 'Platform selection', intent: 'high' },
  { q: 'how do mid-size hospitals cut readmission rates', e: 'aio', won: YOU, topic: 'Clinical outcomes', intent: 'high' },
  { q: 'which analytics tools track clinical outcomes', e: 'aio', won: R2, topic: 'Clinical analytics', intent: 'high' },
  { q: 'NABH compliance software comparison', e: 'aio', won: R1, topic: 'Compliance', intent: 'high' },
  { q: 'affordable HIMS for multi-specialty clinics', e: 'aio', won: NONE, topic: 'Platform selection', intent: 'medium' },
  { q: 'hospital dashboards for length-of-stay reporting', e: 'aio', won: YOU, topic: 'Clinical analytics', intent: 'medium' },
  { q: 'electronic prescribing systems for Indian hospitals', e: 'aio', won: YOU, topic: 'Platform selection', intent: 'medium' },
  { q: 'how to benchmark clinical quality metrics', e: 'aio', won: R1, topic: 'Clinical analytics', intent: 'high' },
  { q: 'ICU capacity planning software', e: 'aio', won: R1, topic: 'Operations', intent: 'medium' },
  { q: 'patient no-show reduction tools', e: 'aio', won: R2, topic: 'Patient engagement', intent: 'medium' },
  { q: 'hospital inventory management best practices', e: 'aio', won: YOU, topic: 'Operations', intent: 'low' },
  { q: 'how to reduce OT turnaround time', e: 'aio', won: YOU, topic: 'Operations', intent: 'low' },

  /* ── ChatGPT ────────────────────────────────────────────────────── */
  { q: 'top patient engagement software in India', e: 'chatgpt', won: YOU, topic: 'Patient engagement', intent: 'high' },
  { q: 'vendors for hospital revenue cycle automation', e: 'chatgpt', won: YOU, topic: 'Revenue cycle', intent: 'high' },
  { q: 'which platform is best for readmission tracking', e: 'chatgpt', won: YOU, topic: 'Clinical outcomes', intent: 'high' },
  { q: 'clinical decision support tools comparison', e: 'chatgpt', won: R1, topic: 'Clinical analytics', intent: 'high' },
  { q: 'hospital software for NABH accreditation reporting', e: 'chatgpt', won: R1, topic: 'Compliance', intent: 'high' },
  { q: 'teleconsultation platforms for tier-2 cities', e: 'chatgpt', won: YOU, topic: 'Telehealth', intent: 'medium' },
  { q: 'best outcome dashboards for private hospitals', e: 'chatgpt', won: YOU, topic: 'Clinical analytics', intent: 'medium' },
  { q: 'how do hospitals measure length of stay', e: 'chatgpt', won: R1, topic: 'Clinical analytics', intent: 'medium' },
  { q: 'nursing rostering software for hospitals', e: 'chatgpt', won: R2, topic: 'Operations', intent: 'medium' },
  { q: 'tools to track infection control indicators', e: 'chatgpt', won: R2, topic: 'Clinical outcomes', intent: 'medium' },
  { q: 'hospital billing integration options', e: 'chatgpt', won: R1, topic: 'Revenue cycle', intent: 'low' },
  { q: 'what does a hospital data warehouse cost', e: 'chatgpt', won: YOU, topic: 'Platform selection', intent: 'low' },

  /* ── Perplexity ─────────────────────────────────────────────────── */
  { q: 'best software to compare hospital outcomes', e: 'perplexity', won: R1, topic: 'Clinical analytics', intent: 'high' },
  { q: 'which vendors handle multi-site hospital reporting', e: 'perplexity', won: R1, topic: 'Platform selection', intent: 'high' },
  { q: 'analytics platforms used by Indian hospital chains', e: 'perplexity', won: YOU, topic: 'Clinical analytics', intent: 'high' },
  { q: 'how to shorten emergency department wait times', e: 'perplexity', won: YOU, topic: 'Operations', intent: 'medium' },
  { q: 'patient feedback platforms for hospitals', e: 'perplexity', won: R2, topic: 'Patient engagement', intent: 'medium' },
  { q: 'software for hospital quality audits', e: 'perplexity', won: R1, topic: 'Compliance', intent: 'high' },
  { q: 'best way to track surgical outcomes', e: 'perplexity', won: YOU, topic: 'Clinical outcomes', intent: 'medium' },
  { q: 'hospital reporting tools that integrate with existing EHR', e: 'perplexity', won: R1, topic: 'Platform selection', intent: 'medium' },
  { q: 'discharge summary automation tools', e: 'perplexity', won: NONE, topic: 'Operations', intent: 'low' },
  { q: 'referral tracking for hospital networks', e: 'perplexity', won: R2, topic: 'Patient engagement', intent: 'low' },
  { q: 'what metrics do hospital boards review monthly', e: 'perplexity', won: NONE, topic: 'Clinical analytics', intent: 'low' },
  { q: 'day-care procedure scheduling software', e: 'perplexity', won: YOU, topic: 'Operations', intent: 'low' },
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

/* Six winning answers cite a page you control, spread across the engines. */
const OWN_CITED_AT = [1, 6, 12, 18, 26, 35];

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

    return {
      prompt: item.q,
      engine: item.e,
      topic: item.topic,
      intent_tier: item.intent,
      source: 'category_seed',
      is_branded_query: false,
      aio_present: true,
      answer_present: true,
      aio_text: answerText(item.won, item.q, brand),
      aio_references: refs,
      aio_citations: refs,
      brand_mentioned_in_text: mine,
      brand_cited: cited,
      visible: mine,
      competitors_found_in_text: rivals,
      competitors_cited: item.won === R1 && i % 2 === 0 ? [RIVAL_NAME[R1]] : [],
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
  /* Rival domains the engines reached for, counted from the answers. */
  const rivalDomains = { 'northpeak.com': 9, 'lumeniq.ai': 5 };
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

  const total = rows.length;                             /* 36 */
  const wins = rows.filter((r) => r.visible).length;     /* 15 */

  const perEngine = {};
  ENGINE_KEYS.forEach((k) => {
    const of = rows.filter((r) => r.engine === k);
    perEngine[k] = {
      share_of_ai_pct: Math.round((of.filter((r) => r.visible).length / of.length) * 100),
      visible: of.filter((r) => r.visible).length,
      answered: of.length,
    };
  });

  /* 15 of 36 rounds to 42, but every surface in the product quotes 41, and
     one reading may not disagree with itself. The row counts are the thing
     that has to add up; the headline is stated once, here. */
  const share = 41;

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

    promptsAnalyzed: total,
    promptsTracked: total,
    competitorsFound: 7,
    scanTimestamp: new Date().toISOString(),
    scoringVersion: 'demo-1',

    /* `engines` is what flips the shell into multi-engine index mode. */
    engines: perEngine,
    engineScores: perEngine,
    probeSources: ENGINE_KEYS,
    perEngineSummaries: perEngine,

    summary:
      `${name} is named in ${wins} of the ${total} answers the engines returned for its category. `
      + `${RIVAL_NAME[R1]} holds 12 of the rest, mostly on NABH-aligned reporting, ${RIVAL_NAME[R2]} `
      + `holds 6, and three answers name no vendor at all. The clearest opening is bed-count sizing, `
      + `which every rival-held answer organises itself around.`,

    results: rows,

    topPrompts: SET.map((item) => ({
      prompt: item.q,
      topic: item.topic,
      intent: item.intent,
      engine: item.e,
      rank: item.won === YOU ? 1 : '—',
      volume: item.intent === 'high' ? 'High' : item.intent === 'medium' ? 'Medium' : 'Low',
    })),

    topDomains,

    /* Discovered from the answers themselves — never a list you maintain.
       A brand is never its own rival: listing it here produced duplicate
       rows and duplicate React keys in every chart. */
    competitors: [
      { name: 'NorthPeak', mentions: 12, prompts: 12, citations: 9, visibilityScore: 33, userAbsent: true, source: 'discovered' },
      { name: 'Lumen IQ', mentions: 6, prompts: 6, citations: 5, visibilityScore: 17, userAbsent: true, source: 'discovered' },
      { name: 'Vantage Health', mentions: 4, prompts: 3, citations: 2, visibilityScore: 8, userAbsent: false, source: 'discovered' },
      { name: 'Coreset', mentions: 3, prompts: 2, citations: 1, visibilityScore: 6, userAbsent: false, source: 'discovered' },
      { name: 'Pulse Metrics', mentions: 2, prompts: 2, citations: 1, visibilityScore: 6, userAbsent: true, source: 'discovered' },
      { name: 'Echelon Care', mentions: 2, prompts: 1, citations: 0, visibilityScore: 3, userAbsent: false, source: 'discovered' },
      { name: 'Meridian HIS', mentions: 1, prompts: 1, citations: 0, visibilityScore: 3, userAbsent: true, source: 'discovered' },
    ],
  };
}

export const SAMPLE_RESULT = buildMockResult('Brightwave', 'brightwave.io');

export { ENGINE_LABEL, SET as DEMO_SET };
