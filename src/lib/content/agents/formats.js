/**
 * Content format registry — the "what" of a custom agent.
 *
 * A format is a first-class, data-driven output shape. The draft step reads
 * the selected format's `structure` directive; the review step reads its
 * `checklist` additions. Adding a format here makes it available to every
 * agent with no code changes elsewhere — this is the extensibility surface
 * the OS is built around.
 *
 * `base` is which pipeline mechanics a format defaults to:
 *   - geo_article: citation-optimized, scan-grounded, long-form
 *   - linkedin_post: short social, brief-grounded
 * An agent can override the base, but the default keeps sensible pairings.
 */

export const FORMATS = {
  article: {
    key: "article",
    label: "GEO article",
    emoji: "📄",
    base: "geo_article",
    blurb: "Passage-optimized long-form built to win AI citations.",
    length_hint: "900–1600 words",
    structure:
      "A passage-optimized GEO article: question-phrased H2s matching the fan-out, each section answer-first in its first 40–60 words, tables for comparisons, the strongest self-contained answer in the first 30% of the page.",
    checklist: [
      "Question-phrased H2s matching the fan-out",
      "Each section answers in its first 40–60 words",
      "Strongest self-contained answer in the first 30%",
    ],
  },
  listicle: {
    key: "listicle",
    label: "Listicle",
    emoji: "🔢",
    base: "geo_article",
    blurb: "Ranked, scannable list — the format AI engines lift item-by-item.",
    length_hint: "700–1300 words",
    structure:
      "A ranked listicle. Open with a 2–3 sentence intro that states what the list ranks and the ranking criterion. Then N items, each as an H2 heading '## <n>. <Item name>' followed by a 40–90 word explanation that LEADS with why it earns its rank (the citable claim first), backed by a specific fact from the research pack. Close with a one-line takeaway. Keep every item self-contained so an engine can lift one without the rest.",
    config_schema: { items: { label: "Number of items", type: "number", default: 7 }, ranked: { label: "Ranked (vs unordered)", type: "bool", default: true } },
    checklist: [
      "Each item is an H2 with a self-contained answer",
      "Item explanations lead with the citable claim",
      "Every item cites a specific research-pack fact",
    ],
  },
  comparison: {
    key: "comparison",
    label: "Comparison",
    emoji: "⚖️",
    base: "geo_article",
    blurb: "Head-to-head decision page — the shape review/versus queries reward.",
    length_hint: "800–1400 words",
    structure:
      "A comparison page. LEAD with a comparison TABLE: rows = the options, columns = the decision criteria that matter to the persona (price, coverage, turnaround, etc.). Follow the table with a short 'best for' verdict per option (one tight paragraph each), then a decision-guidance closing. The table is the centerpiece an engine cites.",
    checklist: [
      "Opens with a comparison table (options × criteria)",
      "One 'best for' verdict per option",
      "Criteria are persona-relevant, not generic",
    ],
  },
  faq: {
    key: "faq",
    label: "FAQ page",
    emoji: "❓",
    base: "geo_article",
    blurb: "Question-answer pairs — direct-answer extraction targets.",
    length_hint: "600–1200 words",
    structure:
      "An FAQ page. Each entry is a question-phrased H2 (the real query a user types), answered in ≤60 words, answer-first, self-contained. Group related questions. Every factual answer cites a research-pack source. No throat-clearing between questions.",
    checklist: [
      "Question-phrased H2s matching real queries",
      "Each answer ≤60 words, answer-first",
      "Factual answers carry a source",
    ],
  },
  how_to: {
    key: "how_to",
    label: "How-to guide",
    emoji: "🪜",
    base: "geo_article",
    blurb: "Numbered procedure — stepwise-extraction format.",
    length_hint: "700–1300 words",
    structure:
      "A how-to guide. A one-paragraph intro naming the outcome and who it's for, then numbered steps. Each step is an H2 '## Step <n>: <action>' with a bold imperative action line and a 40–80 word explanation. Include prerequisites and a short 'common mistakes' close. Steps must be self-contained and ordered.",
    checklist: [
      "Numbered, ordered, self-contained steps",
      "Each step leads with a bold imperative action",
      "Prerequisites and common-mistakes bookends",
    ],
  },
  linkedin_post: {
    key: "linkedin_post",
    label: "LinkedIn post",
    emoji: "💼",
    base: "linkedin_post",
    blurb: "Hook-first executive-voice post.",
    length_hint: "150–300 words",
    structure:
      "A single LinkedIn post in the brief's executive voice: a standalone hook line, the evidence (one number/example from the pack), the implication for the persona, and a crisp close. Channel formatting rules apply.",
    checklist: [
      "First line stands alone before 'see more'",
      "One idea, one number, at most one soft CTA",
      "150–300 words, no banned openers",
    ],
  },
  thread: {
    key: "thread",
    label: "Social thread",
    emoji: "🧵",
    base: "linkedin_post",
    blurb: "Multi-post thread — hook then numbered beats.",
    length_hint: "5–8 posts",
    structure:
      "A numbered thread. Post 1 is the hook (a standalone claim with a number). Posts 2–N each make ONE point in ≤280 characters, numbered '2/', '3/', … building the argument. The final post lands the takeaway and one soft CTA. Separate posts with a line of '—'.",
    config_schema: { posts: { label: "Number of posts", type: "number", default: 6 } },
    checklist: [
      "Post 1 is a standalone hook with a number",
      "Each post makes exactly one point, ≤280 chars",
      "Final post lands the takeaway",
    ],
  },
};

export const FORMAT_KEYS = Object.keys(FORMATS);

export function getFormat(key) {
  return FORMATS[key] || FORMATS.article;
}

/** The base pipeline a format runs on, unless the agent overrides it. */
export function baseForFormat(key) {
  return getFormat(key).base;
}
