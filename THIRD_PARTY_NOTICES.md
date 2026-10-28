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
- `src/lib/providers/dataforseo/core.ts`
- `src/lib/providers/dataforseo/core.test.ts`
- `src/lib/providers/dataforseo/envelope.ts`
- `src/lib/providers/dataforseo/envelope.test.ts`
- `src/lib/providers/dataforseo/billingClassification.ts`
- `src/lib/providers/dataforseo/shared.ts`
- `src/lib/providers/dataforseo/llmSchemas.ts`
- `src/lib/providers/dataforseo/llm-models.ts`
- `src/lib/providers/dataforseo/llm-models.test.ts`
- `src/lib/providers/dataforseo/ai-tracking.ts`
- `src/lib/providers/dataforseo/ai-tracking.test.ts`
- `src/lib/providers/dataforseo/ai.ts`
- `src/lib/providers/dataforseo/ai.test.ts`
- `src/lib/providers/dataforseo/appendix.ts`
- `src/lib/providers/dataforseo/dataforseoEvidence.ts`
- `src/lib/providers/dataforseo/dataforseoEvidence.test.ts`
- `src/lib/providers/dataforseo/locations.ts`
- `src/lib/providers/dataforseo/bakeoffLib.ts`
- `src/lib/providers/dataforseo/bakeoffLib.test.ts`
- `src/shared/web-search-countries.ts`
- `src/shared/safe-url.ts`- `src/styles/app-theme.css` (from `src/client/styles/app.css`)
- `src/lib/theme/theme.ts` (from `src/client/lib/theme.ts`)
- `src/components/ui/accordion.tsx` (from `src/client/components/ui/accordion.tsx`)
- `src/components/ui/alert-dialog.tsx` (from `src/client/components/ui/alert-dialog.tsx`)
- `src/components/ui/alert.tsx` (from `src/client/components/ui/alert.tsx`)
- `src/components/ui/badge.tsx` (from `src/client/components/ui/badge.tsx`)
- `src/components/ui/button.tsx` (from `src/client/components/ui/button.tsx`)
- `src/components/ui/card.tsx` (from `src/client/components/ui/card.tsx`)
- `src/components/ui/chart.tsx` (from `src/client/components/ui/chart.tsx`)
- `src/components/ui/checkbox.tsx` (from `src/client/components/ui/checkbox.tsx`)
- `src/components/ui/collapsible.tsx` (from `src/client/components/ui/collapsible.tsx`)
- `src/components/ui/combobox.tsx` (from `src/client/components/ui/combobox.tsx`)
- `src/components/ui/dialog.tsx` (from `src/client/components/ui/dialog.tsx`)
- `src/components/ui/dropdown-menu.tsx` (from `src/client/components/ui/dropdown-menu.tsx`)
- `src/components/ui/empty.tsx` (from `src/client/components/ui/empty.tsx`)
- `src/components/ui/field.tsx` (from `src/client/components/ui/field.tsx`)
- `src/components/ui/input-group.tsx` (from `src/client/components/ui/input-group.tsx`)
- `src/components/ui/input.tsx` (from `src/client/components/ui/input.tsx`)
- `src/components/ui/label.tsx` (from `src/client/components/ui/label.tsx`)
- `src/components/ui/progress.tsx` (from `src/client/components/ui/progress.tsx`)
- `src/components/ui/radio-group.tsx` (from `src/client/components/ui/radio-group.tsx`)
- `src/components/ui/select.tsx` (from `src/client/components/ui/select.tsx`)
- `src/components/ui/separator.tsx` (from `src/client/components/ui/separator.tsx`)
- `src/components/ui/sheet.tsx` (from `src/client/components/ui/sheet.tsx`)
- `src/components/ui/sidebar.tsx` (from `src/client/components/ui/sidebar.tsx`)
- `src/components/ui/skeleton.tsx` (from `src/client/components/ui/skeleton.tsx`)
- `src/components/ui/spinner.tsx` (from `src/client/components/ui/spinner.tsx`)
- `src/components/ui/switch.tsx` (from `src/client/components/ui/switch.tsx`)
- `src/components/ui/table.tsx` (from `src/client/components/ui/table.tsx`)
- `src/components/ui/tabs.tsx` (from `src/client/components/ui/tabs.tsx`)
- `src/components/ui/textarea.tsx` (from `src/client/components/ui/textarea.tsx`)
- `src/components/ui/toggle-group.tsx` (from `src/client/components/ui/toggle-group.tsx`)
- `src/components/ui/toggle.tsx` (from `src/client/components/ui/toggle.tsx`)
- `src/components/ui/tooltip.tsx` (from `src/client/components/ui/tooltip.tsx`)
- `src/components/app/hooks/use-mobile.ts` (from `src/client/hooks/use-mobile.ts`)
- `src/components/app/theme/useThemePreference.ts` (from `src/client/lib/theme.ts`)
- `src/components/app/theme/ThemePreferenceRadio.tsx` (from `src/client/components/ThemePreferenceMenuItems.tsx`)
- `src/components/app/SegmentedToggle.tsx` (from `src/client/components/SegmentedToggle.tsx`)
