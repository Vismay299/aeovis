# Third-party notices

This project contains portions ported from the open-source projects below.

## every-app/open-seo (MIT)

Pinned reference: `c5f8db19c7ca9e750836b6ed5c8a6491d4f967f4`.

MIT License

Copyright (c) 2026 Ben Senescu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### Files containing ported portions

- `src/lib/http/schemaContract.ts`
- `src/lib/http/routeContract.test.ts`
- `src/lib/http/hostPolicy.ts`
- `src/lib/jobs/stepConfigs.ts`
- `src/lib/jobs/watchdog.ts`
- `src/lib/spend/index.ts`
- `src/lib/cache/providerCache.ts`
- `src/lib/llm/openrouter.ts`
- `src/lib/pricing/dataforseo.ts`
- `src/lib/pricing/dataforseo.test.ts`
- `src/shared/ai-visibility-pricing.ts`
- `src/shared/ai-visibility-pricing.test.ts`
- `src/shared/money.ts`
- `src/lib/telemetry/server.ts` (and `server.test.ts` message-stripping cases)
- `src/shared/privacy-choices.ts` (and `privacy-choices.test.ts`)
- `src/lib/telemetry/sanitize.ts` (and `sanitize.test.ts`)
- `src/lib/telemetry/client.ts` (and `client.test.ts` buffer/opt-in cases)
- `supabase/migrations/041_f01_spend.sql`
- `src/shared/project-context.ts`
- `src/shared/project-context.test.ts`
- `src/lib/projectContext/normalize.ts`
- `src/lib/projectContext/normalize.test.ts`
- `src/lib/projectContext/contextUpdateOps.ts`
- `src/lib/projectContext/contextUpdateOps.test.ts`
- `src/lib/projectContext/repository.ts`
- `src/lib/projectContext/service.ts`
- `src/lib/projectContext/service.test.ts`
- `scripts/qa/check-f07-db.mjs`
- `supabase/migrations/070_f07_project_memory.sql`
- `src/assistant/skills/ai-prompt-research/SKILL.md` (`.agents/skills/ai-prompt-research/SKILL.md`)
- `src/assistant/skills/ai-visibility-audit/SKILL.md` (`.agents/skills/ai-visibility-audit/SKILL.md`)
- `src/assistant/skills/competitive-landscape/SKILL.md` (`.agents/skills/competitive-landscape/SKILL.md`)
- `src/assistant/skills/competitor-analysis/SKILL.md` (`.agents/skills/competitor-analysis/SKILL.md`)
- `src/assistant/skills/keyword-research/SKILL.md` (`.agents/skills/keyword-research/SKILL.md`)
- `src/assistant/skills/keyword-clustering/SKILL.md` (`.agents/skills/keyword-clustering/SKILL.md`)
- `src/assistant/skills/link-prospecting/SKILL.md` (`.agents/skills/link-prospecting/SKILL.md`)
- `src/assistant/skills/local-seo/SKILL.md` (`.agents/skills/local-seo/SKILL.md`)
- `src/assistant/skills/seo-audit/SKILL.md` (`.agents/skills/seo-audit/SKILL.md`)
- `src/assistant/skills/seo-coach/SKILL.md` (`.agents/skills/seo-coach/SKILL.md`)
- `src/assistant/skills/seo-project-setup/SKILL.md` (`.agents/skills/seo-project-setup/SKILL.md`)
- `src/assistant/skills/frontmatter.ts` (`src/server/features/sam/samSkills.ts` frontmatter schema, parse and internal filter)
- `src/assistant/skills/index.ts` (`src/server/features/sam/samSkills.ts` fingerprint, catalog cache and load)
- `src/assistant/skills/skills.test.ts` (`src/server/features/sam/samSkills.test.ts` served-skill guard)
