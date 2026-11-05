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
- `src/app/api/customer/context/route.ts`
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
- `src/components/app/queryStateView.ts` (from `src/client/components/QueryState.tsx`)
- `src/components/app/hooks/useCopy.ts` (from `src/client/hooks/useCopy.ts`)
- `src/components/app/PageHeader.tsx` (from `src/client/components/PageHeader.tsx`)
- `src/components/app/EmptyState.tsx` (from `src/client/components/EmptyState.tsx`)
- `src/components/app/ErrorState.tsx` (from `src/client/components/ErrorState.tsx`)
- `src/components/app/SkeletonPresets.tsx` (from `src/client/components/SkeletonPresets.tsx`)
- `src/components/app/ConfirmDialog.tsx` (from `src/client/components/ConfirmDialog.tsx`)
- `src/components/app/InlineConfirm.tsx` (from `src/client/components/InlineConfirm.tsx`)
- `src/components/app/CopyButton.tsx` (from `src/client/components/CopyButton.tsx`)
- `src/components/app/Spinner.tsx` (from `src/client/components/Spinner.tsx`)
- `src/components/app/HelpLabel.tsx` (from `src/client/components/HelpLabel.tsx`)
- `src/components/app/GateCard.tsx` (from `src/client/components/GateCard.tsx`)
- `src/components/app/RowActionsMenu.tsx` (from `src/client/components/RowActionsMenu.tsx`)
- `src/components/app/ChartAxes.tsx` (from `src/client/components/ChartAxes.tsx`)
- `src/components/app/CardShell.tsx` (from `src/client/components/CardShell.tsx`)
- `src/components/app/FormDialog.tsx` (from `src/client/components/FormDialog.tsx`)
- `src/components/app/FormActions.tsx` (from `src/client/components/FormActions.tsx`)
- `src/components/app/SafeExternalLink.tsx` (from `src/client/components/SafeExternalLink.tsx`)
- `src/components/app/ExpandableList.tsx` (from `src/client/components/ExpandableList.tsx`)
- `src/components/app/Markdown.tsx` (from `src/client/components/Markdown.tsx`)
- `src/components/app/StatusScreen.tsx` (from `src/client/components/StatusScreen.tsx`)
- `src/components/app/PermissionHint.tsx` (from `src/client/components/PermissionHint.tsx`)
- `src/components/app/CountryCombobox.tsx` (from `src/client/components/CountryCombobox.tsx`)
- `src/components/app/LocationSelect.tsx` (from `src/client/components/LocationSelect.tsx`)
- `src/components/app/AppBanner.tsx` (from `src/client/layout/AppBanner.tsx`)
- `src/components/app/NotFound.tsx` (from `src/client/components/NotFound.tsx`)
- `src/components/app/ErrorBoundaryCard.tsx` (from `src/client/components/DefaultCatchBoundary.tsx`)
- `src/components/app/NavTabs.tsx` (from `src/client/components/NavTabs.tsx`)
- `src/components/app/QueryState.tsx` (from `src/client/components/QueryState.tsx`)
- `src/lib/pricing/pricedActions.ts`
- `src/lib/pricing/actions/scanRun.ts`
- `src/lib/costs/usage.ts` (from `src/server/billing/usage.ts`)
- `src/components/app/navigation/navModel.ts` (from `src/client/navigation/items.ts`)
- `src/components/app/navigation/navModel.test.ts` (from `src/client/navigation/items.ts`)
- `src/components/app/navigation/items.ts` (from `src/client/navigation/items.ts`)
- `src/components/app/shell/AppShell.tsx` (from `src/client/layout/AppShell.tsx`)
- `src/components/app/shell/MobileTopBar.tsx` (from `src/client/layout/AppShell.tsx`)
- `src/components/app/shell/AppSidebar.tsx` (from `src/client/components/Sidebar.tsx`)
- `src/components/app/shell/AccountMenu.tsx` (from `src/client/components/Sidebar.tsx`)
- `src/components/app/shell/ScanRunningCard.tsx` (from `src/client/components/Sidebar.tsx`)
- `src/components/app/shell/WorkspaceSwitcher.tsx` (from `src/client/features/projects/ProjectSwitcher.tsx`)
