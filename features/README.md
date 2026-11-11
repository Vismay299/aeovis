# Features: adopting OpenSEO's lead areas into Perceev

> <!-- doc-status -->
> **Status: LIVE.** Planning index created 21 October 2026. Specs are implementation plans, not shipped work. Track progress in each spec's checkboxes and in the Status column below.

## What this folder is

The 20 October teardown ([`Open SEO/OpenSEO-vs-Perceev.html`](../Open%20SEO/OpenSEO-vs-Perceev.html)) compared OpenSEO (`every-app/open-seo`, MIT) with Perceev. It found 26 capabilities where OpenSEO leads. The owner decided to adopt all of them except **billing** and the **MCP server**, to add **classic SEO**, to **trial DataForSEO**, to **reuse OpenSEO's code**, and to make the customer app's **UI/UX match OpenSEO's**.

Each feature has one spec, detailed enough that an AI agent can implement it phase by phase without guessing. Read these first, in order:

1. [`00-CONVENTIONS.md`](./00-CONVENTIONS.md): stack decisions, how OpenSEO's infrastructure maps onto ours, code-reuse and licence rules, safety rules, shared foundation APIs, testing and PR rules. **Binding for every spec and every implementation PR.**
2. [`_TEMPLATE.md`](./_TEMPLATE.md): the structure every spec follows.
3. [`_OPEN-ITEMS.md`](./_OPEN-ITEMS.md): cross-spec fixes still owed and every owner decision with its default.
4. The spec for the feature you are building.

## Owner decisions (21 October 2026)

| Decision | Outcome |
|---|---|
| Adopt every capability where OpenSEO leads | Yes, except billing and MCP |
| Classic SEO (keywords, ranks, domains, backlinks, local) | Yes |
| DataForSEO | Trial first (F02 phase 1), then integrate |
| Billing / payments | Not now. Spend is still metered and capped (F01, F03) |
| MCP server and external agent plugins | Not now. Tool layer is built MCP-ready (F22) |
| Reuse OpenSEO code | Yes, logic and UI. Not their Cloudflare infrastructure |
| UI/UX | Match OpenSEO's customer app (F04, F05, F06), keeping Perceev's name and logo |
| "Mixed" rows from the comparison | Deferred; the owner will decide later. Specs must not change them |
| Claude as an answer engine (25 Oct 2026) | Not for now. No Claude engine, route, label or Prompt Explorer model; see `00-CONVENTIONS.md` |

## Feature index

Waves are the build order. A feature may start when everything in its **Depends on** column is merged. Migration numbers are reserved per feature so parallel PRs never collide.

| ID | Feature | Comparison row(s) covered | Wave | Depends on | Migrations | Status |
|---|---|---|---|---|---|---|
| [F01](./F01-platform-foundations.md) | Platform foundations: TypeScript, durable jobs, spend guard, provider cache, LLM helper | Backend patterns | 0 | none | 040–044 | Merged |
| [F02](./F02-dataforseo-provider.md) | DataForSEO provider and bake-off | Engines and capture; "What I could not verify" | 0 | F01, F03 phase 1 (price tables) | 045–049 | In progress |
| [F03](./F03-cost-ledger.md) | Cost ledger and per-answer cost | Cost per answer | 0 | F01 (F04, F05 for phase 4 UI) | 050–054 | In progress |
| [F04](./F04-design-system-and-app-shell.md) | Design system and app shell (OpenSEO UI/UX) | UI/UX decision; Frontend patterns | 0 | F01 (phase 1 TypeScript, phase 2 flags) | 055–059 | In progress |
| [F05](./F05-client-data-layer.md) | Client data layer and interaction patterns | Frontend patterns | 0 | F04 | 060–064 | Merged |
| [F06](./F06-data-tables-and-export.md) | Data tables and export | Tables and export | 0 | F04, F05 | 065–069 | In progress |
| [F07](./F07-project-memory.md) | Project memory | Project memory | 1 | F01 | 070–074 | Merged |
| [F08](./F08-ai-question-setup.md) | AI-drafted question setup and curation | Questions at setup; question handling | 1 | F02, F03, F07, F09 | 075–079 | In progress |
| [F09](./F09-price-before-running.md) | Price before running | Price before running | 1 | F03 | 080–084 | Merged |
| [F10](./F10-customer-scheduling.md) | Customer scheduling | Scheduling | 1 | F01, F09 | 085–089 | In progress |
| [F11](./F11-prompt-explorer.md) | Prompt Explorer (ask one question now) | Ask one question now | 1 | F02, F03, F04, F05, F08, F09 | 090–094 | In progress |
| [F12](./F12-question-detail-history.md) | Question detail and answer history | Answer detail view | 1 | F05, F08 | 095–099 | Spec ✓ |
| [F13](./F13-keyword-research.md) | Keyword research and saved keywords | Keyword research | 2 | F01, F02, F03, F06, F07 phase 1 | 100–104 | In progress |
| [F14](./F14-domain-overview.md) | Domain overview and competitor research | Domain and competitor research | 2 | F07 phase 1, F13 | 105–109 | In progress |
| [F15](./F15-rank-tracking.md) | Rank tracking with AI Overview presence | Rank tracking | 2 | F01, F02, F03, F06, F07 phase 1, F09, F10, F13, F14 (phase 1); F08 + F12 for phase 6 | 110–114 | Spec ✓ |
| [F16](./F16-backlinks.md) | Backlinks | Backlinks | 2 | F02, F06, F07 phase 1, F13 (phase 1 research kit) | 115–119 | In progress |
| [F17](./F17-local-seo.md) | Local SEO | Local SEO | 2 | F02, F07, F09, F13 | 120–124 | In progress |
| [F18](./F18-site-audit.md) | Site audit crawler (plus Perceev's AEO checks) | Site audit | 3 | F01, F02, F06, F08 (Firecrawl price), F09 | 125–129 | In progress |
| [F19](./F19-indexnow.md) | IndexNow | IndexNow | 3 | F01, F04, F05; F18 for phase 3 | 130–134 | In progress |
| [F20](./F20-ga4-and-opportunities.md) | Google Analytics 4 and search opportunities | Google Analytics 4 | 3 | F01, F04, F05 | 135–139 | In progress |
| [F21](./F21-agent-skills.md) | Agent skills library | Agent skills | 4 | F01 | 140–144 | Merged |
| [F22](./F22-in-app-assistant.md) | In-app assistant (chat over our tools) | In-app chat agent | 4 | F01, F03, F04, F05, F07–F20, F21 | 145–149 | Spec ✓ |
| [F23](./F23-reports-and-sharing.md) | Reports and public sharing | Reports and sharing | 4 | F21, F22 | 150–154 | Spec ✓ |
| [F24](./F24-sign-in-hardening.md) | Sign-in hardening: Google, captcha, disposable email | Sign-in | 5 | F04 | 155–159 | In progress |
| [F25](./F25-lifecycle-email.md) | Lifecycle email | Lifecycle email | 5 | F01, F10, F24 | 160–164 | In progress |
| [F26](./F26-product-analytics.md) | Product analytics and error tracking | Product analytics | 5 | F01 | 165–169 | In progress |
| [F27](./F27-onboarding-wizard.md) | Onboarding wizard | Onboarding | 5 | F07, F08, F09, F18, F20, F24, F25, F26 | 170–174 | Spec ✓ |

Status values: **Spec** (written), **In progress** (first PR open), **Merged** (all phases merged), **Accepted** (acceptance criteria verified on a deployment).

### Coverage check: the 24 adopted "they lead" rows

Engines and capture → F02 · Cost per answer → F03 · Questions at setup → F08 · Scheduling → F10 · Price before running → F09 · Ask one question now → F11 · Answer detail view → F12 · Keyword research → F13 · Rank tracking → F15 · Domain and competitor research → F14 · Backlinks → F16 · Local SEO → F17 · Site audit → F18 · IndexNow → F19 · Google Analytics 4 → F20 · Reports and sharing → F23 · Agent skills → F21 · In-app chat agent → F22 · Project memory → F07 · Sign-in → F24 · Lifecycle email → F25 · Product analytics → F26 · Onboarding → F27 · Tables and export → F06.

Also covered: backend patterns (F01), frontend patterns and the UI/UX decision (F04, F05), the DataForSEO verification gap (F02 phase 1).

### Excluded by decision

- **Billing** (Autumn/Stripe credits). Spend is still estimated, held, settled and capped per workspace (F01, F03), so billing can attach later without rework.
- **MCP server, OAuth for agents, API keys, ChatGPT widgets, external plugin distribution.** F22's tool layer uses MCP-compatible tool definitions so a server can be added later.

### Deferred "Mixed" rows (owner to decide)

Stable question set · Trend comparability · Competitors (tracking side) · Citations and sources · Search Console · Teams · Free tools. Specs touching these areas must preserve current behaviour and say so.

## How to run a feature

1. Read `00-CONVENTIONS.md` and the spec.
2. Fetch the OpenSEO reference at the pinned commit (see `00-CONVENTIONS.md` § Reference checkout).
3. Build one phase per PR. Tick the subtask checkboxes in the spec within the same PR.
4. A phase is done only when its **Checkpoint** commands pass and its acceptance criteria are covered by tests.
5. Update the Status column here when the first PR opens and when the last one merges.
