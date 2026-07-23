# Agent Content OS — v1 (zero integrations, in-app everything)

**Date:** 2026-07-23
**Scope:** The first buildable slice of the GEO operating system: a coordinated agent
pipeline that goes ideation → research → benchmark analysis → draft → QA review →
**human approval in our own app** → displayed in our own app → feedback becomes
stored lessons that improve future runs.
**Explicitly NOT in this build:** WordPress, Slack/Telegram/Discord, LinkedIn API,
GSC wiring, auto-publishing anywhere, LangGraph/CrewAI, auth/multi-tenancy.
The existing dormant `gsc.js` stays untouched and unused (it is not part of this system).
**Baseline:** main @ 9dae050 (v9 multi-engine scans live).

---

## 0. Design synthesis (read this first)

Two inputs shaped this plan:

1. **The GEO thesis** (strategy brief): win AI citations with passage-optimized
   content targeted at scan gaps; the scan is the sensor, content is the actuator,
   re-scan lift is the proof.
2. **Co-founder's agent system**: coordinator + research agent + trend-analysis
   agent + creator agent + approval/execution agent with per-post human feedback +
   self-learning from that feedback + a master accuracy agent. Example channel:
   LinkedIn. Vertical: Indian hospitals, multi-chain clinics, diagnostics centers,
   pharmacies. Personas: CXO / senior executives.

**Synthesis: ONE pipeline, TWO playbooks.** The stages are identical; only the
prompt packs, rubrics, and output format differ:

| Stage | `geo_article` playbook | `linkedin_post` playbook |
|---|---|---|
| Input | A scan gap (query where brand is absent / rank-not-cited) | Topic + brand profile (vertical, persona) |
| Research | The AI's verbatim current answers + scraped winning cited pages + PAA | Same sources + brand profile angles |
| Benchmark | Structure/patterns of currently-cited pages | Encoded LinkedIn best-practice pack (no live LinkedIn data without an API — v1 limitation, offset by the lessons loop) |
| Draft | Passage-optimized long-form (GEO paper playbook) | Hook-first CXO-voice post |
| Review rubric | Facts, citation validity, authority, chunkability, GEO checklist | Facts, hook strength, persona fit, format checklist |
| "Publish" | Approved → visible in Studio, linked to target queries, `content_events` row for lift tracking | Approved → visible in Studio with copy-to-clipboard (human posts manually) |

**Agent-name mapping** (co-founder's design → this build):

| Co-founder's agent | Here | Form |
|---|---|---|
| Main coordinator | `coordinate` step | Plans the work order per job |
| Research agent | `research` step | Firecrawl + scan-data grounded |
| Trend/industry-analysis agent | `benchmark` step | Cited-page analysis / channel pack |
| Content creator agent | `draft` step | Channel prompt pack + lessons injected |
| Approval/execution agent | **Studio queue in our app** | Approve / request changes / reject, with comments |
| Self-learning from feedback | `learn` step | Feedback distilled into stored lessons, injected into future prompts |
| Master accuracy agent | `review` step + job guardrails | Rubric scoring, bounded revision loop, hard caps |

"Concurrent agents" is satisfied the boring way: multiple jobs run independently
through the same fire-and-forget worker pattern as `scan_jobs`. No orchestration
framework — plain sequential steps per job, schema-validated between steps.
That was the locked pragmatism call and it stands.

---

## 1. Locked decisions

1. **Zero external integrations.** Everything (trigger, review, approval, display,
   export) happens inside the Perceev app. "Push to LinkedIn" = copy button.
2. **Model split:** scoring/prompt-gen stays on the free OpenRouter model
   (unchanged rule). Content steps (coordinate/research/benchmark/draft/review)
   use `CONTENT_MODEL` env — a paid, capable model via the existing OpenRouter
   client (`llm.js` gains a `contentModel` option; default
   `anthropic/claude-sonnet-4.5`, overridable). Est. cost: ₹2–8 per GEO article,
   <₹1 per LinkedIn post. Cap: `CONTENT_MAX_COST_PER_ITEM` guard.
3. **Human gate is mandatory and terminal.** Nothing reaches "approved" without a
   click in Studio. Revision loop: max 2 automatic draft→review cycles, then it
   goes to the human queue regardless (flagged "below threshold").
4. **Healthcare vertical = first brand-profile preset** (hospitals / multi-chain
   clinics / diagnostics / pharmacies; CXO personas). **YMYL rule:** this is the
   highest-scrutiny content category on the internet. The reviewer rubric carries
   hard rules: no clinical/medical claims without a cited source; business/ops/
   strategy angle over medical advice; conservative statistics discipline. A
   failed YMYL check can never be auto-revised into a pass — it always routes to
   the human with the violation named.
5. **Anti-slop is a first-class requirement** (the documented #1 failure mode of
   agent content systems): research step must ground every draft in named sources;
   draft prompts demand specific stats/quotes/citations (the +34%/+41% GEO levers);
   review rubric scores authority and specificity; lessons from human feedback
   accumulate per brand+playbook.
6. **Same stack, same patterns.** Next.js 14 JS + Supabase. `content_jobs` mirrors
   `scan_jobs` exactly (fire-and-forget worker, status polling, cron resume).
   No new infra.
7. **Agent prompts are authored as skill-style markdown files, not inline strings.**
   Pattern taken from the Claude skills ecosystem (claude-seo pack / Amadora
   playbook): each step×playbook gets `src/lib/content/skills/<step>.<playbook>.md`
   with YAML frontmatter (name, playbook, inputs, output JSON schema) and a body
   containing the workflow, a **weighted rubric with strong/weak signal lists and
   hard thresholds**, and 1–2 worked examples. The runtime loads + interpolates
   them. Why: git-versioned prompt iteration, and the co-founder can tune agent
   behavior by editing markdown — no code changes.
8. **The Brand Brief is a first-class artifact** (replaces the vaguer "brand
   profile preset"). One per brand, written once, injected into EVERY step —
   never re-explained per prompt. Blocks: one-liner (what they sell), vertical +
   target personas, 3–6 priority topics, money pages, competitor set, tone &
   format rules ("tables not listicles", "always cite a stat"), platforms that
   matter, and **definition of a win** (cited URL vs mention vs approval).
   Editable in Studio. First shipped brief: `healthcare-cxo` (Indian hospitals /
   multi-chain clinics / diagnostics / pharmacies; CXO & senior-executive
   personas).

**New env:**
```
CONTENT_MODEL=anthropic/claude-sonnet-4.5   # via OpenRouter, paid
CONTENT_MAX_COST_PER_ITEM=0.15              # USD hard stop per item
```

---

## 2. Schema — `supabase/migrations/002_content_os.sql`

(Extend `setup:db` to apply all migration files in order, not just 001.)

```sql
-- Pipeline jobs (mirrors scan_jobs)
CREATE TABLE IF NOT EXISTS content_jobs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  brand text NOT NULL,
  playbook text NOT NULL,             -- 'geo_article' | 'linkedin_post'
  status text NOT NULL,               -- pending|coordinating|researching|benchmarking|drafting|reviewing|awaiting_approval|approved|rejected|failed
  progress_pct integer DEFAULT 0,
  input jsonb,                        -- gap row / topic / brand profile
  item_id uuid,                       -- FK set once the item exists
  error_message text,
  cost_total numeric DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- The content itself, with full provenance
CREATE TABLE IF NOT EXISTS content_items (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id uuid REFERENCES content_jobs(id) ON DELETE SET NULL,
  brand text NOT NULL,
  playbook text NOT NULL,
  title text,
  body_md text,                       -- current draft (markdown)
  research_pack jsonb,                -- sources, stats, quotes, angles
  benchmark_notes jsonb,              -- what wins in this category/channel
  rubric jsonb,                       -- reviewer scores + verdict + violations
  revision integer DEFAULT 0,
  revisions jsonb DEFAULT '[]',       -- prior drafts + critiques
  target_queries jsonb,               -- geo_article: queries this aims to win
  status text DEFAULT 'draft',        -- draft|awaiting_approval|approved|changes_requested|rejected
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Human feedback events (the raw signal)
CREATE TABLE IF NOT EXISTS content_feedback (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  item_id uuid REFERENCES content_items(id) ON DELETE CASCADE,
  brand text NOT NULL,
  verdict text NOT NULL,              -- approved|changes_requested|rejected
  comment text,
  created_at timestamptz DEFAULT now()
);

-- Brand briefs (the write-once context every step inherits)
CREATE TABLE IF NOT EXISTS brand_briefs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  brand text NOT NULL UNIQUE,
  brief jsonb NOT NULL,               -- one_liner, vertical, personas, priority_topics, money_pages, competitors, tone_rules, platforms, win_definition
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Distilled lessons (the self-learning store)
CREATE TABLE IF NOT EXISTS content_lessons (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  brand text NOT NULL,
  playbook text NOT NULL,
  lesson text NOT NULL,               -- one imperative rule, <200 chars
  source_feedback_id uuid REFERENCES content_feedback(id) ON DELETE SET NULL,
  active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);
```

RLS + anon policies matching the existing tables (same single-operator model as
the rest of the app — auth is a later, separate workstream).

---

## 3. Phases

### Phase 1 — Pipeline engine (`src/lib/content/`)

- `contentWorker.js` — `startContentJob(jobId)`, fire-and-forget, status writes,
  identical shape to `scanWorker.js`. Steps run sequentially; every step's output
  is validated against a small schema before the next step runs (reject → retry
  once → fail the job with the step named).
- `steps/coordinate.js` — from `input` (+ latest scan for the brand, if any):
  choose angle, target queries (geo) or hook thesis (linkedin), assemble the work
  order. Injects the **brand brief** + **active lessons** for brand+playbook.
  For geo_article the work order includes a **query fan-out**: the target query
  expanded into the 6–12 sub-queries the engines actually decompose it into —
  each becomes a section the draft must answer (fan-out gives the sections;
  the teardown below gives the shape).
- `steps/research.js` — build the research pack:
  - geo_article: the target queries' verbatim AI answers + citations from the
    latest scan (`raw_results`), Firecrawl-scrape the top 2–3 winning cited pages,
    PAA questions for the topic. Output: named sources, extractable stats, quotes.
  - linkedin_post: same sources filtered through the brand profile (vertical +
    persona pains).
  - Hard rule: every stat/quote in the pack carries its source URL.
- `steps/benchmark.js` — for geo_article this is a **citation teardown**, not a
  vague "analysis": from the target queries' citations (already stored per scan
  row) + the scraped winners, classify the **format distribution** (comparison /
  listicle / how-to / FAQ / glossary / data-study, as %) and apply a decision
  table:
  | Teardown finding | Directive to the draft |
  |---|---|
  | One format >60% of citations | Build exactly that format — don't fight the model's preference |
  | Reddit/forums cited heavily | Model wants unbiased answers → clean, citable page answering those threads |
  | Review/marketplace site dominating | Third-party proof wins here → flag "earned placement" in the work order notes (out of scope to execute, but named) |
  | Citations spread thin | Open field — speed matters more than perfection |
  | Brand mentioned but never cited | Structure problem, not authority problem → fan-out + citability fixes |
  - linkedin_post: static channel pack (hook patterns, formatting, length, CTA
    discipline) — honest v1 note: no live LinkedIn data without an API; the
    lessons loop is the personalization mechanism instead.
- `steps/draft.js` — channel prompt pack + work order + research pack + lessons.
  GEO pack encodes the citation levers with **hard numbers** (from the GEO paper +
  claude-seo pack synthesis): citable passages of **134–167 words**; the direct
  answer inside the **first 40–60 words of each section**; the strongest
  self-contained answer in the **first 30% of the page** (~44% of AI citations
  come from there); question-based H2s matching the fan-out sub-queries; tables
  for comparisons, lists for steps; quotable stats + expert quotes + cited
  sources (+34%/+41%/+30% levers); "X is..." definition patterns. LinkedIn pack
  encodes CXO-voice copywriting practice.
- `steps/review.js` — rubric scoring 0–1 per dimension (facts-vs-research-pack,
  citation validity, authority/specificity [anti-slop], brand voice, channel
  checklist, YMYL compliance for healthcare profiles). Verdict: pass → queue;
  fail → one critique-driven redraft; second fail → queue anyway, flagged.
- `steps/learn.js` — on human feedback with a comment: distill into 1–3 imperative
  lessons, dedupe against existing (LLM call), insert `content_lessons`.
- **Tests:** step-schema validation, revision-loop caps, lessons injection,
  YMYL routing — fixture-based, no live calls.

**Gate:** `npm run test:scoring` green (suite picks up new test files); a job run
end-to-end against a fixture scan produces a reviewed item in `awaiting_approval`.

### Phase 2 — API routes

- `POST /api/content` — create job `{ brand, playbook, input }`; 409 duplicate
  guard like scans.
- `GET /api/content/[job_id]/status` — poll (mirror scan status route,
  `force-dynamic`).
- `GET /api/content-items?brand=` — list items + statuses (`force-dynamic`).
- `POST /api/content-items/[id]/decision` — `{ verdict, comment }` → status
  change + `content_feedback` row + fire `learn` step + (on approve, geo_article)
  insert `content_events` row keyed to target queries for existing lift tracking.

### Phase 3 — Studio UI (in-app, Perceev design system)

- Sidebar gains **Studio** with a badge count of `awaiting_approval`.
- **Queue view:** items grouped by status; each card: playbook badge, title,
  brand, rubric verdict chips, revision count.
- **Item view:** rendered draft; tabs for Research pack (sources/stats/quotes),
  Benchmark notes, Rubric (per-dimension scores + violations), Revisions.
  Actions: **Approve** / **Request changes** (comment required) / **Reject**
  (comment required). Copy-markdown + copy-plaintext buttons (the manual
  LinkedIn "push").
- **Trigger points:**
  - AnswersView gap rows get "Generate content" (prefilled geo_article job from
    that query's row — the AI's current answer and citations ride along as input).
  - Studio "New content" form: brand, playbook, topic, brand-profile preset
    (first preset: `healthcare-cxo` — hospitals/clinics/diagnostics/pharmacies,
    CXO persona).
- **Lessons panel** (minimal): list per brand+playbook, toggle active.
- **Brand brief editor** (minimal): the block-structured form (one-liner,
  vertical/personas, priority topics, money pages, competitors, tone rules,
  win definition), seeded from the `healthcare-cxo` template on first use.

**Gate:** full loop in the browser — trigger from a gap row → job completes →
review in Studio → request changes with a comment → revised item returns →
approve → lesson appears → next job's draft prompt contains it.

### Phase 4 — Cadence + measurement

- Daily batch (optional, default off): `CONTENT_DAILY_BATCH=n` — cron worker
  (existing daily cron) creates up to n jobs from the worst uncovered gaps of the
  most recent scan per brand. Off until dogfooding proves quality.
- GEO lift: approved geo_articles already write `content_events`; surface the
  existing `contentLift` computation on the item view after the next scan
  ("target queries: 3 → visible on 1 since publish").
- **Weekly report** (skill-style, one LLM call over scan history + content
  activity, lands in Studio): 3 KPIs with week-over-week deltas, per-engine
  visibility, top movers, and **exactly three priorities** — each backed by a
  number and tied to a concrete next action ("Perplexity share dropped 8%,
  driven by X — generate content for these 2 gaps"). Fifteen "opportunities" is
  a to-do list nobody runs; three with numbers is a plan. This report is also
  the retention artifact the future paid tier emails to clients.

### Phase 5 — Dogfood verification (healthcare vertical)

1. Scan a real Indian healthcare brand (e.g. a diagnostics chain) — multi-engine.
2. Generate 2 geo_articles from its worst rank-not-cited / absent gaps and
   3 linkedin_posts from the healthcare-cxo preset.
3. Full approval loop with real feedback comments; verify lessons distill and
   inject; verify YMYL rubric flags at least one deliberately-planted claim.
4. Cost check: total spend for the batch printed per job, under caps.

---

## 4. Risks & honest notes

- **YMYL/healthcare** is the hardest possible first vertical for AI content —
  that is why the rubric treats it specially and the human gate is terminal.
  Business/ops-angle content (CXO persona) largely sidesteps clinical claims;
  the rubric enforces the sidestep.
- **No live LinkedIn trend data** without an integration — benchmark step is a
  curated pack + lessons loop for now. Revisit only when an integration is
  explicitly wanted.
- **Slop risk** is mitigated, not eliminated: grounded research + authority
  rubric + human gate + lessons. The dogfood phase is the real test; if drafts
  read generic, fix the packs before any client sees them.
- **Model spend** is bounded per item; the free-model rule for scoring is intact.
- **Epistemic balance:** Google's official position is that "GEO is still SEO" and
  it explicitly rejects llms.txt / chunk-hacking / mention-farming as levers.
  Community thresholds (passage lengths, format preferences) are directional,
  vendor-grade evidence — encode them in the packs, but let the **teardown of
  what actually gets cited per topic** and the **re-scan lift numbers** overrule
  any static rule. Our own scan data is the only ground truth we fully trust.
- **Only ~11% of domains get cited by both ChatGPT and Google AIO for the same
  query** — platform preferences genuinely diverge. The teardown should note
  per-engine citation differences (we store citations per engine per query), and
  drafts may eventually need per-engine emphasis. v1: one draft per gap; note
  divergence in benchmark output.

## 5. Out of scope (explicit)

WordPress/CMS, Slack/Telegram/Discord, LinkedIn API, GSC wiring, auth/multi-
tenancy, orchestration frameworks, auto-publish, image generation, scheduling.
