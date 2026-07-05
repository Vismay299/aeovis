# AI Visibility & Answer Engine Optimization (AEO) Tracker
## MVP Implementation Document v1.0

**July 2026**

This document provides a complete, step-by-step implementation guide for building a production-ready MVP similar to JustBlank / Profound Answer Engine Insights.

---

## 1. Executive Summary & Product Vision

### Product Vision
Build a clean, professional, and actionable AI Visibility / Answer Engine Optimization (AEO) dashboard that helps brands understand and improve how they appear in AI-generated answers (ChatGPT, Claude, Perplexity, Gemini, Google AI Overviews, etc.).

### Target MVP Experience (Inspired by Reference Screenshots)
- Clean sidebar navigation (Analytics, Prompts, Opportunities, Citations, etc.)
- Prominent Visibility Score with trend line (e.g., 72.9% +0.7%)
- Competitor ranking table with visibility scores
- Prompts tab showing Topics → Sub-prompts with per-prompt visibility, position, and citation share
- Ability to see which prompts are performing well and which need optimization
- Clear citation/source tracking

### MVP Success Criteria
- User can add a brand + website and get a **personalized, relevant** set of prompts + visibility insights in under 2 minutes.
- The dashboard clearly shows where the brand appears, where it loses to competitors, and 2-4 high-potential fixes.
- A second or third scan on the same brand produces visible history/trend data.
- The experience feels professional enough to screenshot and show investors.

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

---

## 2. MVP Scope Definition

### In Scope for MVP
- Brand onboarding (name + website URL)
- Automated prompt generation using LLM + website content (highest priority)
- Tracking using the Gemini API exclusively for the MVP.
- On-demand visibility runs with manual re-run support + basic historical scan storage for trends
- Visibility Score calculation (% of prompts where brand is mentioned)
- Basic trend visualization (last few runs)
- Per-prompt visibility breakdown grouped by Topics (progressive)
- Citation / Source extraction (which URLs appear in AI answers)
- Simple competitor comparison (user adds 2-4 competitors; collected at scan time)
- Basic "Opportunities / Goldmines" view (prompts where visibility is low but potential exists)
- User can edit/disable/add custom prompts
- Clean, responsive dashboard with sidebar navigation (implemented incrementally)

### Out of Scope for MVP (Post-MVP)
- Real user prompt volume data (like Profound's Prompt Volumes) — too expensive/hard for MVP
- Support for 8-10+ AI engines on day one
- Advanced sentiment analysis or persona-based tracking
- Agent Analytics / crawler monitoring on user's site
- Content generation / AEO content briefs (can be added later)
- Multi-user teams, permissions, white-labeling
- Shopping visibility or region/language breakdowns
- Public benchmarks / industry indexes

### Key Trade-off Decision
**We will NOT attempt to build accurate absolute prompt volume numbers in the MVP.** Instead, we will focus on relative opportunity signals (visibility gaps vs competitors, semantic relevance to user's existing visibility). This is the pragmatic path taken by many successful lighter AEO tools.

**Pitch-Ready MVP Slice (Prioritized for Investor Demo)**
Focus execution on:
1. Dynamic prompt generation from real website content (biggest differentiator).
2. Improved structured analysis (mentions + basic citations/position via Gemini).
3. Collect & use 2-4 competitors.
4. Persist scans and surface simple trend/history in the dashboard.
5. One "Opportunities" view (even if simple heuristic + LLM why).
Everything else (full sidebar, topics grouping, advanced scheduling) can be stubbed or added after the core loop proves the value.

---

## 3. User Personas & Core User Journey

### Primary Persona: Growth / Performance Marketer or Founder
- **Role**: Solo founder, performance marketer, or small growth team at a D2C/SaaS brand
- **Goal**: Understand and improve how their brand appears when people ask AI chatbots questions
- **Pain**: They know AI search is important but have no visibility into it. SEO tools don't cover answer engines well.
- **Success**: They can see clear numbers, identify 3-5 high-impact actions per week, and measure improvement over time.

### Core User Journey (MVP)
1. User lands on the product and signs up (or starts free trial).
2. Onboarding — Enters brand name + website URL. System auto-generates initial prompt set.
3. First visibility run completes in < 90 seconds (on-demand).
4. User lands on Dashboard → sees Visibility Score, trend, competitor comparison.
5. User explores Prompts tab → sees which topics/prompts are strong vs weak.
6. User checks Citations → understands which of their pages are being cited.
7. User visits Opportunities → sees prioritized list of prompts to optimize for.
8. User adds custom prompts or disables irrelevant ones.
9. Over the next days/weeks, user monitors score improvement after content changes.

---

## 4. Information Architecture & Navigation

### Recommended Sidebar Navigation (Left Panel)
- Overview (Dashboard home)
- Visibility Score & Trends
- Prompts (with Topics grouping)
- Citations & Sources
- Opportunities / Goldmines
- Competitors
- Settings (Prompt limits, models to track, notification preferences)

### Top Bar / Header
- Brand selector / current brand name + logo
- Date range selector (Last 7 days, Last 30 days, Custom)
- Model filter (Currently Gemini only for MVP, but UI should support future additions)
- Export button
- User avatar / account menu

---

## 5. Detailed UI/UX Specifications (Screen by Screen)

**Note**: The current prototype implements a simplified, high-quality single-screen dashboard + scan flow. The full information architecture and screens described below are the north star and will be approached incrementally (see Roadmap in Section 9). Start by extending the existing dashboard components.

### 5.1 Onboarding & Brand Setup Screen
**Goal**: Get the user from zero to first insights with minimal friction.

- Screen 1.1: Welcome + "Add your first brand" CTA (big, prominent button)
- Screen 1.2: Simple form with two fields: Brand Name (pre-filled from domain if possible) + Website URL
- Screen 1.3 (Optional but recommended): "What industry/category is this brand in?" (dropdown or multi-select tags: D2C, SaaS, Finance, Health, etc.)
- Screen 1.4: "How many competitors do you want to track?" (default 3, user can add names)
- Screen 1.5: Confirmation screen with estimated time for first report (e.g., "We'll have your first visibility report ready in the next 2-6 hours")
- Background: System immediately starts scraping key pages + generating initial prompts using LLM

### 5.2 Main Dashboard Overview (Home Screen)
This is the first screen users see after onboarding (inspired by the Nike screenshot).

- Top section: Big Visibility Score card (e.g., 72.9%) with WoW change (+0.7%) and sparkline trend
- Right side or below: Visibility Score Rank card (#1 in category or vs added competitors)
- Main chart area: Line chart showing Visibility Score over time (last 14 or 30 days)
- Below chart: Competitor comparison mini-table (Name | Visibility Score | Change)
- Quick stats row: Total Prompts Tracked | Avg Position | Share of Voice | Citations Count
- Recent Activity / Alerts section (e.g., "Your visibility on 'best running shoes' increased 18% this week")

### 5.3 Visibility Score & Trend Analysis
- Use a clean line chart (Chart.js or Recharts recommended)
- Allow toggling between Current Period vs Previous Period
- Show confidence band or daily variance if possible (AI answers fluctuate)
- Clicking on a data point should ideally filter the Prompts table below to that date's results (stretch for MVP)

### 5.4 Prompts & Topics Management Screen
This is one of the most important screens (directly inspired by the second screenshot).

- Top controls: Search bar, Group by: Topic / All Prompts, Filter by visibility (High/Medium/Low), Add Custom Prompt button
- Main table: Columns → Topic (expandable) | # of Prompts | Visibility % | Avg Position | Citation Share | Trend
- Expandable rows: When user clicks a Topic row, it expands to show individual prompts with the same columns
- Each prompt row should show: Prompt text | Visibility % | Change | Avg Position | Citation Share | Actions (View details / Disable)
- Color coding: Green for positive change, Red for negative, neutral for flat
- Bulk actions: Select multiple prompts → Disable / Move to different topic (future)

### 5.5 Citations & Sources Screen
- Two main sections: 'Your Cited Pages' and 'Top Sources Overall'
- Your Cited Pages: Table showing which of the user's own URLs are being cited by AI, frequency, and associated prompts
- Top Sources Overall: Shows domains/URLs that AI is citing most frequently for the tracked prompts (including competitors)
- Ability to filter by Topic or specific Prompt
- Simple insight callout: "X% of citations are coming from your blog posts" or "Competitor Y is dominating citations in Topic Z"

### 5.6 Opportunities / Goldmines View
This is where you deliver actionable value beyond pure reporting.

- Header: "High Potential Prompts You're Missing or Underperforming On"
- Table columns: Prompt | Estimated Potential (High/Med/Low or simple score) | Your Visibility | Competitor Visibility | Why it's an opportunity | Suggested Action
- Sorting: Default by biggest gap (high competitor visibility + low or zero your visibility)
- Each row has a "Why this matters" explanation generated by LLM (e.g., "This prompt has high commercial intent and 3 competitors are consistently cited")
- Quick win filters: "Prompts where you have 0% visibility but competitors appear" / "Prompts semantically close to your strong topics"

### 5.7 Competitor Comparison Screen
- Simple table: Competitor | Visibility Score | # Prompts Where They Appear | Avg Position | Share of Voice
- Side-by-side bar chart comparing visibility across shared topics
- Ability to add/remove competitors easily
- Highlight areas where you beat a specific competitor or where they dominate

---

## 6. Backend Architecture Overview

### Backend Architecture for MVP (Next.js + Supabase + Gemini)

We are extending the existing Next.js codebase.

**High-Level Components (MVP)**:
- Next.js App Router API routes (`/api/scan`, future `/api/brands`, etc.)
- Supabase (Postgres + client) for storing scan records, brands (simple), and results. Start with JSONB for flexibility in `scans` or new `scan_runs` table.
- LLM Client: `@google/generative-ai` only (Gemini). Use structured JSON output where possible.
- Prompt Generation Service (new): Use Firecrawl (when key configured) or basic fetch to get clean website content, then LLM to generate 15-25 targeted prompts. See `src/lib/firecrawl.js` and `src/lib/prompts.js`.
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

---

## 7. Data Models & Database Schema

### Core Tables (Simplified for MVP)

| Table Name          | Key Fields                                              | Purpose                              |
|---------------------|---------------------------------------------------------|--------------------------------------|
| users               | id, email, created_at, plan (free/paid)                 | Authentication & billing             |
| brands              | id, user_id, name, website_url, industry, created_at    | Core entity being tracked            |
| competitors         | id, brand_id, name, website_url                         | Competitors added by user            |
| prompt_topics       | id, brand_id, name, description, created_at             | Grouping for prompts (e.g. Basketball) |
| prompts             | id, topic_id, text, is_active, source (generated/manual), created_at | Individual prompts being tracked |
| tracking_runs       | id, brand_id, run_date, model, status, total_prompts, completed_at | One daily/weekly execution |
| prompt_results      | id, run_id, prompt_id, model, mentioned (bool), position, full_response, citations (jsonb), sentiment | Result of one prompt on one model |
| citations           | id, result_id, url, domain, is_own_domain (bool)        | Normalized citation data for easy querying |

**Note**: Use JSONB heavily in `prompt_results` for flexibility (citations, raw metadata). Add indexes on `brand_id + run_date` for fast dashboard queries.

**MVP Starting Point**: For the initial pitch MVP we can start simpler — extend the existing flat `scans` table (with `raw_results` JSONB) or create a minimal `scan_runs` + `prompt_results` pair in Supabase. Full normalization can be introduced once the core value is proven. Use Supabase directly from Next.js API routes.

---

## 8. Core Modules — Detailed Specifications

### 8.1 Prompt Generation Module
This is critical for good user experience on day one and the highest-leverage feature for the pitch MVP.

**Current Implementation**:
- Dedicated scraper in `src/lib/firecrawl.js`
- Uses Firecrawl (`@mendable/firecrawl-js`) when `FIRECRAWL_API_KEY` is configured for clean, JS-rendered markdown + metadata (title, description).
- Falls back to basic `fetch` + HTML stripping.
- Called from `src/lib/prompts.js` → `generatePromptsForBrand()`
- Integrated in `/api/scan` (dynamic prompts first, static industry fallback)

Steps (for reference):
1. Scrape the brand website using Firecrawl (preferred) or basic fetch.
2. Feed the clean summary + brand/industry into Gemini with a structured prompt.
3. Generate 15-20 high-quality prompts.
4. Use the generated prompts for visibility tracking (fall back to static if generation fails).
5. (Future) Store generated prompts per brand/run for editing.

Emphasize: Dynamic, website-aware prompt generation from the user's actual content is the core differentiator to demonstrate. Firecrawl significantly improves the quality of the scraped context.

### 8.2 Visibility Tracking Engine
- For the pitch MVP: on-demand synchronous runs (triggered from the scan API). History is built from repeated user-initiated scans.
- For each active prompt of the brand:
  - Call Gemini with the prompt text (use temperature=0.3-0.5 for more consistent answers).
  - Use structured output / JSON mode where possible.
  - If not available, use a follow-up LLM call to extract structured data.
  - Store: `mentioned` (boolean), `position`, `citations` (list of URLs), `raw_response`, `sentiment` (optional).
- After all prompts complete: Calculate aggregate Visibility Score for the run.
- Store historical runs for trend calculation.

**Future**: Move heavy runs to background jobs (Vercel Cron + queue or external) once the core value is validated.

### 8.3 Citation Extraction & Analysis
- During response parsing, extract all URLs mentioned or cited by the LLM.
- Normalize URLs (strip query params, trailing slashes).
- Flag whether the domain belongs to the tracked brand or a competitor.
- Aggregate at brand level: Which of my pages get cited most? For which prompts?
- Show top external sources that AI trusts for this category.

### 8.4 Opportunity / Goldmine Scoring (Simple MVP Version)
Basic heuristic (good enough for MVP):

- **Score** = (Competitor Average Visibility - Your Visibility) × Relevance to your strong topics
- Or even simpler: Show prompts where Your Visibility = 0% but at least one competitor has >30% visibility.
- Enhancement: Use embedding similarity between the prompt and the user's existing high-visibility prompts.
- Display 8-15 prioritized opportunities with a short LLM-generated explanation of why it matters.

---

## 9. Implementation Roadmap (Phased with Small Steps)

**Follow this order. Each phase delivers a working, demo-able increment that can be shown to investors. We extend the existing Next.js prototype rather than starting over.**

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

---

## 10. REST API Endpoints Specification (MVP)

| Endpoint                                      | Description |
|-----------------------------------------------|-------------|
| `POST /api/v1/brands`                         | Create new brand + trigger initial prompt generation |
| `GET /api/v1/brands/{brand_id}/dashboard`     | Main dashboard data (score, trend, competitors) |
| `GET /api/v1/brands/{brand_id}/prompts`       | List prompts (with optional topic filter) |
| `POST /api/v1/brands/{brand_id}/prompts`      | Add custom prompt |
| `PATCH /api/v1/prompts/{prompt_id}`           | Update / disable a prompt |
| `GET /api/v1/brands/{brand_id}/runs`          | List historical tracking runs |
| `GET /api/v1/runs/{run_id}/results`           | Detailed results for one run |
| `GET /api/v1/brands/{brand_id}/citations`     | Citation analysis |
| `GET /api/v1/brands/{brand_id}/opportunities` | Goldmine prompts |
| `POST /api/v1/brands/{brand_id}/competitors`  | Add competitor |
| `POST /api/v1/brands/{brand_id}/trigger-run`  | Manually trigger a tracking run (useful for testing) |

---

## 11. Technical Stack & Infrastructure Recommendations

**MVP — Grounded in Existing Code**
- **Frontend + API**: Next.js 14 (App Router) — keep and extend current setup (`src/app`, components, services/api.js, lib/gemini.js).
- **Database**: Supabase (Postgres). Enhance the existing `scans` pattern or add normalized tables (`brands`, `scan_runs`, `prompt_results`).
- **LLM**: Google Generative AI (Gemini) exclusively. Prefer cheaper/fast models for generation + analysis; use capable model for prompt creation if needed.
- **Auth** (stretch for pitch): Supabase Auth if user accounts are required for saved brands. Otherwise keep anonymous scans + shareable results for MVP.
- **Deployment**: Vercel (perfect for current Next.js).
- **Future (post-pitch)**: Add lightweight job runner (Inngest, QStash, or Supabase + cron) + possibly a thin Python worker only if batch volume requires it.

---

## 12. Cost Estimation & Optimization (Critical)

**LLM API costs will be your largest variable expense.**

- Prompt Generation + run: One-time per brand with 15-25 prompts using Gemini (~ lower cost in practice).
- For pitch demos, use smaller prompt sets (15-20) and cache aggressively.
- **Optimization tips**: Use smaller/faster Gemini models where possible, cache results, batch prompts intelligently, monitor per-brand usage.
- Monitor usage per brand and set alerts / hard limits. For early demos, pre-generate or limit prompt count.

---

## 13. Risks & Mitigations

- **Risk**: LLM API rate limits or outages → **Mitigation**: Retry with exponential backoff, fallback models, queue jobs
- **Risk**: High LLM costs → **Mitigation**: Strict usage tracking, smaller models for routine runs, user plan limits
- **Risk**: Inconsistent AI answers → **Mitigation**: Multiple runs + averaging, clear communication to users that scores have variance
- **Risk**: Legal/ToS issues with heavy automation → **Mitigation**: Start small, respect rate limits, add delays between calls, monitor ToS changes
- **Risk**: Poor prompt quality → **Mitigation**: Invest time in good generation prompts, allow easy user editing
- **Risk**: Vercel function timeout on long scans (many prompts + fetches) → **Mitigation**: Stream progress updates, split generation + analysis steps, start with 15-20 prompts, add client-side timeout handling and clear messaging.

---

## 14. Testing Strategy

- Unit tests for scoring logic and citation parsing
- Integration tests for the full tracking flow (use mock LLM responses first)
- Manual testing with real brands (your own projects or friends' brands)
- Load testing on the worker system before scaling to many users
- Monitor failed runs and have good alerting

---

## 15. Post-MVP Roadmap (Ideas for v2+)

- Real prompt volume / intent data (if you can source it affordably)
- More AI engines (Gemini, Perplexity, Grok, Google AI Overviews)
- Content generation / AEO optimization recommendations
- Site crawler / Agent Analytics (see what AI bots are actually fetching from the user's site)
- Team accounts and collaboration features
- White-label or agency reporting exports
- Advanced opportunity scoring using embeddings + user content analysis

---

## Appendix A: Sample LLM Prompt for Prompt Generation (MVP)

**System Prompt:**

```
You are an expert Answer Engine Optimization strategist. Your job is to generate realistic questions that real users would type into AI chatbots (ChatGPT, Claude, Perplexity, etc.) about a specific brand or topic.

Generate 50-70 high-quality, diverse prompts. Mix:
- Informational / "how to" questions
- Comparison and "vs" questions
- "Best for [use case]" questions
- Problem-solving / pain point questions
- Buyer journey questions (awareness, consideration, decision)

Return ONLY a valid JSON array of objects with this structure:
[{"text": "...", "topic_suggestion": "..."}]

Do not add any extra text outside the JSON.
```

**Note for Pitch MVP**: Target 15-30 prompts in the generation instruction (not 50-70) to keep scans fast and affordable for demos.

**User Message Template:**

```
Brand Name: {brand_name}
Website: {website_url}
Industry / Category: {industry}
Key offerings from website: {website_summary}

Generate the list of prompts now.
```

---

## Appendix B: Example Visibility Score Calculation

**Simple formula for MVP:**

```
Visibility Score = (Number of prompt_results where mentioned = true) / (Total prompt_results in the run) × 100
```

For multi-model: Average across models or show per-model scores.

Trend: Compare current period average vs previous period average.

---

**End of MVP Implementation Document v1.0**

This document is designed to be actionable. Start with Phase 1 and ship incrementally.

Good luck building — this space is still early and execution quality will win.