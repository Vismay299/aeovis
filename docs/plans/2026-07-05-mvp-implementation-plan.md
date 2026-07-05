# Plan: Review, Grill & Refine AEO Visibility Tracker MVP Implementation Document v1

**Date**: 2026-07-05  
**Status**: Approved  
**Related**: [aeo-visibility-tracker-mvp-implementation-document-v1.md](../aeo-visibility-tracker-mvp-implementation-document-v1.md)

**Session Goal**: Brainstorm + critically review the provided implementation doc against the actual current codebase ("basic backend setup"). Identify improvements to the doc so it accurately supports building a pitch-ready MVP. User explicitly requested: grill first (in chat), **do not edit the MD document** until explicit go-ahead.

> This plan lives in `docs/plans/`. See [docs/plans/README.md](../README.md) for the overall planning structure.

---

## Context

- User shared `AEO_Visibility_Tracker_MVP_Implementation_Document_v1.md` (detailed, structured, ambitious guide inspired by JustBlank/Profound-style AEO tools).
- Current project (Next.js) is a polished **demo/prototype**, not the full system described in the doc.
- User wants: understand what we have vs. what doc says we need; what to improve in the doc itself for a credible investor pitch; then (later) execute.
- Key constraint from user: "do not make any changes to the document" until satisfied + explicit "goahead".
- Today: 2026-07-05. Pitch context implies need for demonstrable value, not vaporware.

**Product**: AnswerRank (AEO Visibility Tracker) — measures how often/where a brand appears in AI chatbot answers (Gemini, etc.), surfaces gaps vs competitors, actionable prompts/topics.

---

## Phase 1 Summary: Current Codebase Reality (Read-only Exploration)

Explored via list_dir, read_file (all major files), grep, sqlite inspection, redacted env.

**Tech Stack (actual)**:
- Next.js 14 (App Router) + Tailwind + framer-motion + shadcn/ui (Radix) + lucide-react + sonner.
- LLM: only `@google/generative-ai` (Gemini). Multiple "flash-lite" fallbacks tried.
- Storage: `@supabase/supabase-js` (insert to `scans` table). Also legacy `data/aeo.db` (SQLite) with similar flat `scans` schema.
- Persistence for demo: `sessionStorage` (via services/api.js). No real user accounts, brands, or history.
- No charting library, no task queue, no other LLM SDKs.

**What Exists Today (Functional)**:
- Beautiful editorial landing (`src/app/page.js`): hero, value props, "how it works", sample CTA. Strong design language (#D9531E accent, serif headings, clean spacing).
- `/scan` page: form (brand, website, industry select from `/api/industries`). Progress stages during run. Validates + calls API. Recent sample buttons.
- `/api/scan` (POST): 
  - Takes brand/url/industry + (ignored) competitors.
  - Pulls **3 static prompts** from `src/data/industries.js` (SaaS/Ecom/Finance only; e.g. "best project management software...").
  - For each: appends brand context → sequential `generateContent` (Gemini) → crude JS analysis (`analyzeResponse`).
  - Analysis: `includes(brandLower)` for mentioned, relative index for position ("recommended"/"compared"/"cited"), word-list sentiment, competitor string matches.
  - Computes visibility_pct, stores raw results.
  - Attempts `insertScan` to Supabase (or warns).
- `/dashboard`: Loads from sessionStorage (or empty state). Shows:
  - HeroScoreCard (big % /100 + tier bar ticks).
  - KpiCards.
  - TopPromptsTable (mapped rank/volume).
  - CompetitorTable (mentions + "You absent" badges).
  - InsightPanel (static interpretation + summary + re-run CTA).
- Normalization + mock data in `services/api.js` + `mockData.js` (8 sample prompts, fake competitors).
- UI components: reusable, data-testid heavy (good for testing), polished but narrow scope.
- Navbar/Footer basic routing.

**What's Missing vs. Even a Basic Working Product**:
- **0 dynamic prompt generation or website understanding**. Prompts are generic industry lists (3 total). No scraping, no LLM summarization of site, no brand-specific questions.
- No competitors input in UI/API (hardcoded empty).
- Analysis is brittle string matching (fails on paraphrases, "our company", etc.). No citation URL extraction.
- No persistence/history/trends: one scan result at a time, session only. No runs over time.
- No topics/grouping, no "opportunities/goldmines", no real citations screen.
- No multi-model. No scheduling/background jobs (runs are synchronous, user waits 15-60s+ for 3 calls).
- No brands CRUD, auth, user-owned data, settings.
- Tiny data: 3 prompts → weak demo credibility.
- Supabase table is flat/raw; no relational model.
- Dashboard is read-only snapshot, not interactive (no edit prompts, filters, date ranges).
- No error resilience, retries, cost tracking, rate limiting visible.

**Existing Reusable Assets** (strong foundation):
- Design system, typography, motion, color tokens, layout patterns.
- `gemini.js` generate + fallbacks.
- Scan flow, progress UI, normalization logic.
- Dashboard table/insight components (extendable to tabs: Prompts | Citations | Opportunities).
- `utils/format.js` (tiers, time, rank colors).
- `ScoreBadge.jsx`.
- Sample data for quick iteration.

**Env/Config**: GEMINI_API_KEY + Supabase public keys only. Vercel-friendly.

**Conclusion on "basic backend"**: It's a working **one-shot demo scanner** with excellent frontend polish. The intelligence layer (prompt relevance + analysis quality) is placeholder. Matches "MVP" only for visual pitch of UI, not for proving the AEO value prop.

---

## Gaps vs. Implementation Document v1.0

The doc is excellent as an **aspirational full spec** (exec summary, personas, IA, UI screens, schema, modules for prompt gen/tracking/citations/opps, phased roadmap, APIs, costs, risks, sample prompts, scoring).

But it assumes:
- Starting from scratch.
- Python/FastAPI + PostgreSQL + Celery/Redis + multiple LLM SDKs + scraper (Firecrawl/BS4).
- 40-80 dynamic prompts, topics, relational tables (brands, prompts, tracking_runs, prompt_results, citations), scheduled runs, full CRUD.
- "First visibility run in 2-6 hours", daily jobs, etc.

**Reality mismatch**:
- We already have a Next.js SPA-like frontend + API routes + Supabase.
- Pivoting to Python would discard polished UI work and slow us.
- Core "secret sauce" (LLM prompt generation from site) is completely absent.
- MVP scope in doc is closer to v1.5; too broad for rapid investor demo.
- No accounting for current code state, incremental path, or JS ecosystem constraints (e.g. Vercel function timeouts for long scans, no native background easily).

---

## Recommended Approach (What We'll Do Once Given Go-Ahead)

1. **Grill & Align (this phase, chat)**: Use questions below + discussion to clarify priorities, constraints, definition of "pitchable MVP".
2. **Refine the Document** (only after explicit user "goahead"):
   - Add "Current Prototype State" section.
   - Revise "Recommended Tech Stack" and "Implementation Roadmap" to be **incremental on existing Next.js/Supabase/Gemini**.
   - Trim/prioritize MVP scope for investor pitch (focus on believable core loop + 1-2 "wow" features).
   - Update data models to start from flat scans → evolve, or map to Supabase tables.
   - Make prompt gen realistic for JS (simple fetch homepage + key paths + LLM; or integrate lightweight scraper lib).
   - Add competitor collection in scan/onboarding.
   - Strengthen analysis (recommend structured outputs / follow-up LLM parse for citations/position).
   - Update costs, timing, risks for actual stack + small prompt counts initially.
   - Revise success criteria to be demo-focused.
   - Keep the strong structure (exec, personas, screens, modules) but annotate "MVP pitch slice".
3. **Execution Planning**: After refined doc, produce concrete PR/task breakdown, file changes, reuse points. (May use design skill or execute-plan later.)
4. **Build Incrementally**: Start with prompt generation (biggest gap), better analysis, competitor support, persisted runs + simple trend, then opportunities view. Polish existing UI to match more of doc's IA.

**Key Trade-offs to Resolve with User**:
- Breadth (many doc features) vs. Depth (make 1-2 things credible: dynamic prompts + reliable detection).
- Stack purity (stay full JS for speed/deploy) vs. future (Python workers for heavy jobs).
- "Investor ready" definition: beautiful screenshots + fake data? Or live scan of real brand showing surprising gaps?
- Timeline/budget: how many weeks? LLM cost budget for demos?

---

## Critical Files (Current — Will Guide Later Changes)

**To understand/reuse**:
- `docs/aeo-visibility-tracker-mvp-implementation-document-v1.md` (the target to refine; original root copy was removed after organizing into docs/)
- `src/app/api/scan/route.js` + `src/lib/gemini.js`
- `src/data/industries.js` (will be replaced/supplemented by dynamic gen)
- `src/services/api.js` (normalization, runScan)
- `src/app/scan/page.js`, `src/app/dashboard/page.js`
- Dashboard components: `KpiCard.jsx`, `TopPromptsTable.jsx`, `CompetitorTable.jsx`, `InsightPanel.jsx`
- `src/utils/format.js`, `src/lib/db.js`
- `src/app/page.js` + `DashboardPreview.jsx` (preserve brand voice)

**Later targets** (examples): add prompt gen service, expand /api, new dashboard tabs or pages per doc IA, Supabase schema/migrations if needed, etc.

---

## Grilling Questions (Core of This Session)

These are designed to pressure-test assumptions in the doc and current build. Answer honestly — they will shape a much better, shippable plan.

**On the Document Itself & Scope**
1. The doc is written as if starting clean with Python stack and full features. Given we already invested in a nice Next.js frontend + scan flow, how married are you to the exact roadmap/phases/stack recommendations in the doc? What parts feel non-negotiable for investors?
2. For a pitch, what is the **smallest set of features** that would make an investor say "I see why this matters and how it works"? (e.g. dynamic prompts + visibility score + 1 gap view + competitor contrast?) Which doc sections are nice-to-have vs. must-demo?
3. The doc says "user can add brand + website and get meaningful insights within 24-48h". Current is instant (but fake). Is delayed/async acceptable for MVP, or must scans feel live/fast?

**On Core Technology & Differentiation**
4. **Prompt generation is the biggest missing piece**. Doc emphasizes scraping + LLM-generated 50-70 brand-specific prompts + topics. Right now it's 3 generic ones. Do investors need to see "we understand *your* site" for credibility, or is a good-looking generic report fine for first pitch?
5. Current analysis (string includes + index math) is toy-grade. Should we spend tokens on a second LLM call (or Gemini JSON mode) to extract real citations, better "position in answer", and why mentioned? What's "good enough" accuracy for a pitch?
6. Only Gemini today. Doc wants 2-3 models (GPT + Claude). For MVP pitch, is one model + clear labeling ("powered by Gemini") acceptable, or do we need cross-model consensus to look serious?

**On Data, Persistence & User Experience**
7. No auth, no saved brands, no history. Dashboard is ephemeral. For pitch/demo: is "enter brand → scan → see dashboard (session)" enough? Or do we need to show "my brands", past runs, WoW trend (even simulated)?
8. Competitors: doc and UI expect them. Scan form currently ignores them. Should onboarding/scan collect 2-4 competitor names/URLs upfront? How do we discover them if not provided?
9. Trends & "daily runs" are central to doc (score +0.7%, line chart). Without background jobs or multiple real runs, how do we convincingly show change? (Simulated history? One "before/after" button? Manual re-scan with note?)

**On Practicalities for Pitch**
10. LLM costs + latency: generating prompts + running them (even 15-30) will be slow and cost real $ per demo scan. What's your tolerance/budget? Do we need "demo mode" with heavy caching or pre-generated results for certain brands?
11. Scraping: doc suggests Firecrawl. For MVP in Next.js, can we get away with `fetch` + cheerio (or just send homepage/about text to Gemini for summary)? Any legal/compliance concerns with automated LLM queries on behalf of users?
12. What specific investor questions or objections do you anticipate? (e.g. "How is this different from just asking ChatGPT yourself?", "Is the score reliable?", "What's the moat?", "How do you make money?") — this should directly inform what the refined doc + demo must address.
13. Post-pitch path: once funded, do we keep Next.js for everything (perhaps + Inngest/Upstash/QStash for jobs, Supabase + pg_cron) or plan hybrid (Next frontend + Python worker service)?

**On Process & Go-Forward**
14. When is the actual pitch date/window? How much more dev time do we realistically have before we freeze for demo?
15. Any brands or real use cases we can/should test with during building (your own or friendly)? Any reference screenshots or competitor apps (beyond "inspired by") we should emulate visually or in features?
16. What would make *you* satisfied that the refined document + plan is ready for execution? What would be a red flag in the current doc?

---

## Verification Strategy (After Refinement + During Build)

- **Doc level**: After edits, the document should:
  - Accurately describe current state + delta.
  - Have a trimmed, prioritized MVP slice clearly called out.
  - Provide concrete, stack-aligned next steps that a dev can follow without throwing away existing code.
  - Include measurable success criteria for "pitch ready".
- **Code level** (later): 
  - End-to-end: new brand + url → dynamic prompts generated from site content → scan runs → dashboard shows relevant personalized prompts, real mentions, competitor gaps, basic score.
  - Re-runs produce different or improved results if content changes.
  - UI matches more of doc IA (at least Overview + Prompts + Competitors + Opportunities stub).
  - No regressions on polished landing/scan experience.
- Manual: Run real scans on 2-3 brands, screenshot before/after. Time/cost the flow. Check analysis quality vs manual LLM ask.
- Edge: Invalid urls, API failures, very slow Gemini, empty results.

---

## Open Items / Decisions for User

- Confirm stack direction (JS-first?).
- Define exact MVP feature cut for pitch (use the questions).
- Any preference on adding minimal auth now (e.g. Supabase Auth) vs. later?
- Do we want charts (recharts or chart.js) for trends early?

---

**Status**: Exploration complete. User explicitly requested "can you update the doc with your specs i think you get what i am trying to build" (2026-07-05). This is treated as the go-ahead to prepare the refined document.

**Plan mode constraint**: Per active plan mode rules, **no edits are allowed to the implementation document itself**. This section of the plan file contains the complete, detailed specification of the updates (my specs). Actual modifications to `AEO_Visibility_Tracker_MVP_Implementation_Document_v1.md` will occur only after exit_plan_mode + user approval of this plan.

---

## Doc Refinement Specification (My Specs / Recommended Updates)

**Core Philosophy for the Refined Doc** (what "I get" you are building):
- Beautiful, editorial, high-trust **Next.js frontend** (the current design language, landing, scan flow, and dashboard components are a major asset — preserve and extend them).
- Gemini-only for the entire MVP (cost, simplicity, speed to pitch).
- The **real product** is dynamic, website-aware prompt generation + reliable detection of presence/gaps vs competitors.
- Start from the real prototype you have (static 3-prompt scanner + session dashboard + Supabase attempt) and evolve it incrementally. Do **not** prescribe throwing it away for a new FastAPI project.
- For investor pitch: prioritize a credible **end-to-end core loop** that can be demoed live or near-live:
  1. Enter real brand + URL.
  2. System generates relevant prompts from the site.
  3. Runs them → produces visibility score + concrete prompts + competitor gaps.
  4. Shows some history/trend (even if from 2-3 manual runs) and basic opportunities.
- Keep the ambitious long-term vision but clearly mark the "Pitch-Ready MVP Slice".
- Realistic constraints: synchronous on-demand scans first (Vercel-friendly), 15-30 prompts target initially (not 50-80 on day 1), simple analysis improved via structured Gemini output, persistence via Supabase, history via multiple scan records.
- No Celery/FastAPI for the MVP described. Use Next.js API routes + Supabase + (later) lightweight scheduling (Vercel Cron, Inngest, or Supabase edge functions).

**High-Level Changes to Apply to the MD**:
- Insert a new "Current Prototype Baseline (July 2026)" section early (after Executive Summary or as new subsection in 1).
- Update Scope, journey, and success criteria to be grounded (on-demand, Gemini only, seconds-to-minutes for first report in MVP, start small on prompt count).
- Heavily rewrite Section 6 (Backend Architecture), Section 9 (Roadmap), and Section 11 (Tech Stack).
- Update Section 7 (Data Models) to start from enhancing existing flat/JSON scans + evolve toward normalized.
- Update 8.1 Prompt Gen to be practical for current stack (no mandatory Firecrawl; describe simple fetch + LLM or note optional).
- Tone down daily scheduled runs for MVP pitch; keep as post-MVP or "manual re-run + history" for demo.
- Update costs, risks, testing, APIs to match Next.js reality.
- Keep Sections 2-5, 5.x UI specs, 8.2-8.4, 10 (endpoints can be adapted), 12-15, Appendices mostly intact (they are strong) but add annotations for the pitch slice.
- Add a clear "Pitch-Ready MVP Definition" callout box.

### 1. Specific New Content to Insert

**Insert after the Executive Summary (after line ~30, before "## 2. MVP Scope...") a new subsection:**

```markdown
## 1.5 Current Prototype Baseline (as of July 2026)

A working Next.js prototype already exists with:
- Editorial landing page and "Run a visibility check" flow (brand + website + industry select).
- `/api/scan` that runs a small set of industry prompts through Gemini and returns a visibility score + prompt results + extracted competitor co-mentions.
- Basic dashboard showing AI Visibility Score, Top Prompts table, Competitor Co-Mentions, and insight summary (using sessionStorage for demo + Supabase insert attempt).
- Strong design system (serif + sans, #D9531E accent, clean cards, data-testid coverage).

**Current limitations (the gaps this plan closes first)**:
- Prompts are static + generic (only 3 per industry in `src/data/industries.js`).
- No website content analysis or brand-specific prompt generation.
- Crude string-match analysis (no citations, weak position/sentiment).
- No persistence of multiple runs, no trends, no brand entities.
- Competitors not collected or deeply used.
- Single synchronous scan (no background jobs yet).

The refined MVP will extend this foundation rather than replace it.
```

**Update "MVP Success Criteria"** (in section 1) to:
- User can add a brand + website and get a **personalized, relevant** set of prompts + visibility insights in under 2 minutes.
- The dashboard clearly shows where the brand appears, where it loses to competitors, and 2-4 high-potential fixes.
- A second or third scan on the same brand produces visible history/trend data.
- The experience feels professional enough to screenshot and show investors.

### 2. Updates to Section 2 (MVP Scope Definition)

**In "In Scope for MVP"**:
- Change "Daily or weekly visibility runs (configurable)" → "On-demand visibility runs with manual re-run support + basic historical scan storage for trends"
- Add bullet: "Competitor names collected at scan time"
- Change prompt volume note implicitly via roadmap.
- Keep "Automated prompt generation using LLM + website content" as #1 priority item.

**Update "Core User Journey (MVP)"** step 3 to: "First visibility run completes in < 90 seconds (on-demand)."

**Add after Key Trade-off**:
**Pitch-Ready MVP Slice (Prioritized for Investor Demo)**
Focus execution on:
1. Dynamic prompt generation from real website content (biggest differentiator).
2. Improved structured analysis (mentions + basic citations/position via Gemini).
3. Collect & use 2-4 competitors.
4. Persist scans and surface simple trend/history in the dashboard.
5. One "Opportunities" view (even if simple heuristic + LLM why).
Everything else (full sidebar, topics grouping, advanced scheduling) can be stubbed or added after the core loop proves the value.

### 3. Major Rewrite Targets

**Section 6 Backend Architecture Overview** — Replace most of it with:

### Backend Architecture for MVP (Next.js + Supabase + Gemini)

We are extending the existing Next.js codebase.

**High-Level Components (MVP)**:
- Next.js App Router API routes (`/api/scan`, future `/api/brands`, etc.)
- Supabase (Postgres + client) for storing scan records, brands (simple), and results. Start with JSONB for flexibility in `scans` or new `scan_runs` table.
- LLM Client: `@google/generative-ai` only (Gemini). Use structured JSON output where possible.
- Prompt Generation Service (new): Fetch key pages (homepage + /about or product pages via simple `fetch`), summarize with Gemini, generate 15-30 targeted prompts.
- Analysis Service: Current crude logic → upgraded to ask Gemini for structured extraction (mentioned, position category, cited URLs, sentiment).
- Scoring: Simple % mentioned. Store per-scan.
- Frontend: Existing polished React components + extend dashboard with tabs or sections for history, opportunities.
- No background worker for pitch MVP. Scans are on-demand (user waits). History comes from repeated manual scans.

**Recommended Tech Stack (MVP — Grounded in Existing Code)**
- **Frontend + API**: Next.js 14 (App Router) — keep and extend current setup (`src/app`, components, services/api.js, lib/gemini.js).
- **Database**: Supabase (Postgres). Enhance the existing `scans` pattern or add normalized tables (`brands`, `scan_runs`, `prompt_results`).
- **LLM**: Google Generative AI (Gemini) exclusively. Prefer cheaper/fast models for generation + analysis; use capable model for prompt creation if needed.
- **Auth** (stretch for pitch): Supabase Auth if user accounts are required for saved brands. Otherwise keep anonymous scans + shareable results for MVP.
- **Deployment**: Vercel (perfect for current Next.js).
- **Future (post-pitch)**: Add lightweight job runner (Inngest, QStash, or Supabase + cron) + possibly a thin Python worker only if batch volume requires it.

**Section 7 Data Models**:
- Keep the nice table but add a note:
  "For the initial pitch MVP we can start simpler: extend the existing flat `scans` table (with `raw_results` JSONB) or create a minimal `scan_runs` + `prompt_results` pair. Full normalization can be introduced once the core value is proven. Use Supabase directly from Next.js API routes."

**Section 8.1 Prompt Generation Module** — Rewrite steps to be practical:
1. On scan: fetch homepage + 1-2 key paths (about, product, blog) using native `fetch` + basic parsing (or optional cheerio). Respect robots + add delays.
2. Or simpler MVP: send the raw homepage text (truncated) + brand to Gemini with a summarization + prompt-gen instruction in one or two calls.
3. Generate 15-25 high-quality prompts (start smaller than 40-80 for cost/speed in pitch phase).
4. Assign loose topics via LLM or simple rules.
5. Store the generated prompts with the scan run (or in a prompts table).
6. User can later add/edit (future iteration).

Emphasize: This is the highest-leverage feature to implement first.

**Section 9 Implementation Roadmap** — **Completely replace** with an incremental version based on current files:

### Implementation Roadmap (Incremental on Existing Prototype)

**Follow this order. Each phase delivers a working, demo-able increment that can be shown to investors.**

**Phase 0: Baseline (Already Done)**
- Polished landing + scan form + basic Gemini scanner using static industry prompts.
- Dashboard with score, top prompts, competitor co-mentions.
- Reusable UI components and design system.

**Phase 1: Dynamic Prompt Generation (Highest Priority — Do This First)**
1. Build prompt generation module in `src/lib/` or new `src/services/prompts.js`.
2. Implement website fetch + summarization using Gemini.
3. Replace or augment `INDUSTRY_PROMPTS` with on-the-fly generated prompts (target 15-25 relevant ones).
4. Update `/api/scan` to call the generator when a URL is provided.
5. Update scan form/progress to reflect "generating custom prompts for your brand".
6. Test with 2-3 real brands and compare quality vs static.

**Phase 2: Better Analysis + Competitors + Basic Persistence**
1. Upgrade `analyzeResponse` (or new structured extraction call in gemini.js) to return proper JSON: mentioned, rough position, extracted citation URLs, sentiment, key phrases.
2. Add competitor input to the scan form (text or chips for 2-4 names).
3. Pass competitors into the prompt context and analysis.
4. Persist scans properly to Supabase under a simple `brand` or `scan_id`. Load previous scans for a brand on dashboard.
5. Enhance `normalizeResult` and dashboard to handle real persisted data.

**Phase 3: History, Trends & Core Dashboard Polish**
1. Store multiple runs per brand.
2. Add simple trend calculation (compare last 2-3 runs) and a small sparkline or previous-score display (add Recharts or lightweight chart lib if needed).
3. Update dashboard to show "last scans" list or date selector (even if manual).
4. Extend TopPromptsTable / CompetitorTable with change indicators.
5. Add basic "re-run" that appends new history.

**Phase 4: Opportunities / Actionable Value + Citations Stub**
1. Implement simple opportunity scoring (biggest visibility gaps vs competitors + semantic closeness).
2. Add a new "Opportunities" section or tab in dashboard (reuse existing components).
3. Extract and display basic citations from improved analysis results.
4. LLM-generated "why this matters" for top 3-5 opportunities (cheap model call).
5. Allow basic prompt disabling or custom add (store with the brand/scan).

**Phase 5: Hardening for Pitch + Nice-to-Haves**
1. Error handling, retries, progress improvements, timeout protection in Gemini calls.
2. Cost logging / simple usage display.
3. Better empty/loading/error states.
4. Optional: lightweight auth (Supabase) so users can save "My Brands".
5. Export report button (PDF or clean share link).
6. Polish to match more of the IA in section 4-5 (start adding sidebar or tabbed views if time).

**Post-Pitch / v1.1**:
- Background / scheduled runs (Vercel Cron + queue or external).
- More models.
- Full topic grouping, advanced filters, etc.

**Phase guidance**: Stop after Phase 3 or 4 if the pitch date is soon. A live dynamic-prompt scan + visible history + one opportunities list is extremely strong.

### 4. Other Targeted Updates

**Section 11 Technical Stack** — Replace with the grounded version described above under Architecture.

**Costs (Section 12)**:
- Update numbers realistically: Prompt gen + 20 prompts × Gemini flash ≈ lower cost.
- "For pitch demos, use smaller prompt sets (15-20) and cache aggressively."

**Risks**: Add one about Vercel function timeout for long scans; mitigate with streaming progress + splitting calls.

**Appendix A**: Keep the sample prompt but note "Target 15-30 prompts for MVP pitch version. Adjust count in the generation instruction."

**Success criteria & journey**: Align numbers to seconds/minutes instead of hours where it refers to the runnable MVP.

**UI Screens (5.x)**: Keep the descriptions as the north star. Add a note at the top of section 5: "The current prototype implements a simplified single-screen dashboard. The full IA will be approached incrementally (see Roadmap)."

### 5. What to Leave Largely Unchanged
- Product vision and most of section 1.
- Personas and core journey narrative (just tweak timing).
- Detailed UI/UX specifications (5.1–5.7) — excellent reference.
- Opportunity scoring logic, citation ideas, most of sections 13-15 and appendices.

---

## Execution Notes for the Actual Update (After Approval)

When approved, the AI performed careful `search_replace` operations on the implementation document (now located at `docs/aeo-visibility-tracker-mvp-implementation-document-v1.md`) to apply the spec.

After the MD is updated, we can:
- Optionally run a quick review.
- Move to code execution planning or direct implementation of Phase 1 (dynamic prompts).

**User Go-Ahead (2026-07-05)**: User said "okay goahead update the plan". The detailed specification above (my understanding of the desired MVP grounded in the actual Next.js prototype + Gemini-only + dynamic prompts as the core) has been recorded here.

**APPROVED**: User responded "apprve". The plan (including the full Doc Refinement Specification) is approved. 

Next step (after plan mode): The updates were applied to `docs/aeo-visibility-tracker-mvp-implementation-document-v1.md`.

**Ready State**:
- This plan file now serves as the complete blueprint.
- No further exploration needed.
- When this plan is approved via exit, the next concrete action (outside strict plan mode constraints) will be targeted search_replace calls directly on `AEO_Visibility_Tracker_MVP_Implementation_Document_v1.md` to apply the changes described.

**Remaining ambiguities resolved by judgment** (based on "you get what I am trying to build"):
- Pitch MVP will emphasize **live dynamic prompt generation** + visible gaps + history from repeated scans.
- 15-30 prompts target for the first impressive version.
- Stay 100% in the existing Next.js + Supabase + Gemini stack for everything described in the refined MVP.
- Roadmap is strictly incremental ("extend what exists" not "start FastAPI").

If any of the above calls feel off, reply with adjustments before we apply to the document.

This is the actionable plan.
