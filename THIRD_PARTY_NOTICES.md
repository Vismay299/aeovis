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

- `src/shared/http/schemaContract.ts`
- `src/shared/http/routeContract.test.ts`
- `src/shared/http/hostPolicy.ts`
- `src/server/jobs/stepConfigs.ts`
- `src/server/jobs/watchdog.ts`
- `src/shared/spend/index.ts`
- `src/server/cache/providerCache.ts`
- `src/server/llm/openrouter.ts`
- `src/shared/pricing/dataforseo.ts`
- `src/shared/pricing/dataforseo.test.ts`
- `src/shared/ai-visibility-pricing.ts`
- `src/shared/ai-visibility-pricing.test.ts`
- `src/shared/money.ts`
- `src/shared/telemetry/server.ts` (and `server.test.ts` message-stripping cases)
- `src/shared/privacy-choices.ts` (and `privacy-choices.test.ts`)
- `src/shared/telemetry/sanitize.ts` (and `sanitize.test.ts`)
- `src/shared/telemetry/client.ts` (and `client.test.ts` buffer/opt-in cases)
- `src/components/app/telemetry/TelemetryBootstrap.tsx`
- `src/components/portal/privacy/PrivacySettings.tsx`
- `supabase/migrations/041_f01_spend.sql`
- `src/shared/project-context.ts`
- `src/shared/project-context.test.ts`
- `src/server/projectContext/normalize.ts`
- `src/server/projectContext/normalize.test.ts`
- `src/server/projectContext/contextUpdateOps.ts`
- `src/server/projectContext/contextUpdateOps.test.ts`
- `src/server/projectContext/repository.ts`
- `src/server/projectContext/service.ts`
- `src/server/projectContext/service.test.ts`
- `scripts/qa/check-f07-db.mjs`
- `supabase/migrations/070_f07_project_memory.sql`
- `src/shared/providers/dataforseo/core.ts`
- `src/shared/providers/dataforseo/core.test.ts`
- `src/shared/providers/dataforseo/envelope.ts`
- `src/shared/providers/dataforseo/envelope.test.ts`
- `src/shared/providers/dataforseo/billingClassification.ts`
- `src/shared/providers/dataforseo/shared.ts`
- `src/shared/providers/dataforseo/llmSchemas.ts`
- `src/shared/providers/dataforseo/llm-models.ts`
- `src/shared/providers/dataforseo/llm-models.test.ts`
- `src/shared/providers/dataforseo/ai-tracking.ts`
- `src/shared/providers/dataforseo/ai-tracking.test.ts`
- `src/shared/providers/dataforseo/ai.ts`
- `src/shared/providers/dataforseo/ai.test.ts`
- `src/shared/providers/dataforseo/appendix.ts`
- `src/shared/providers/dataforseo/dataforseoEvidence.ts`
- `src/shared/providers/dataforseo/dataforseoEvidence.test.ts`
- `src/shared/providers/dataforseo/locations.ts`
- `src/shared/providers/dataforseo/bakeoffLib.ts`
- `src/shared/providers/dataforseo/bakeoffLib.test.ts`
- `src/shared/web-search-countries.ts`
- `src/shared/safe-url.ts`- `src/styles/app-theme.css` (from `src/client/styles/app.css`)
- `src/shared/theme/theme.ts` (from `src/client/lib/theme.ts`)
- `src/components/ui/accordion.tsx` (from `src/client/components/ui/accordion.tsx`)
- `src/components/ui/alert-dialog.tsx` (from `src/client/components/ui/alert-dialog.tsx`)
- `src/components/ui/alert.tsx` (from `src/client/components/ui/alert.tsx`)
- `src/components/ui/badge.tsx` (from `src/client/components/ui/badge.tsx`)
- `src/components/ui/button.tsx` (from `src/client/components/ui/button.tsx`)
- `src/components/ui/card.tsx` (from `src/client/components/ui/card.tsx`)
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
- `src/assistant/skills/seo-report/SKILL.md` (`.agents/skills/seo-report/SKILL.md`)
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
- `src/shared/pricing/pricedActions.ts`
- `src/shared/pricing/actions/scanRun.ts`
- `src/server/costs/usage.ts` (from `src/server/billing/usage.ts`)
- `src/components/app/navigation/navModel.ts` (from `src/client/navigation/items.ts`)
- `src/components/app/navigation/navModel.test.ts` (from `src/client/navigation/items.ts`)
- `src/components/app/navigation/items.ts` (from `src/client/navigation/items.ts`)
- `src/components/app/shell/AppShell.tsx` (from `src/client/layout/AppShell.tsx`)
- `src/components/app/shell/MobileTopBar.tsx` (from `src/client/layout/AppShell.tsx`)
- `src/components/app/shell/AppSidebar.tsx` (from `src/client/components/Sidebar.tsx`)
- `src/components/app/shell/AccountMenu.tsx` (from `src/client/components/Sidebar.tsx`)
- `src/components/app/shell/ScanRunningCard.tsx` (from `src/client/components/Sidebar.tsx`)
- `src/components/app/shell/WorkspaceSwitcher.tsx` (from `src/client/features/projects/ProjectSwitcher.tsx`)
- `src/components/portal/settings/tabs.ts` (from `src/client/features/projects/SettingsTabs.tsx`)
- `src/app/portal/settings/layout.tsx` (from `src/routes/_app/p/$projectId/settings.tsx`)
- `src/shared/disposable-email.ts` (from `src/server/auth/disposable-email.ts`)
- `src/shared/disposable-email.test.ts`
- `src/shared/auth-redirect.ts` (from `src/lib/auth-redirect.ts`)
- `src/shared/auth-redirect.test.ts` (from `src/lib/auth-redirect.test.ts`)
- `src/shared/auth-errors.ts` (from `src/client/features/integrations/googleAuthErrorCopy.ts`)
- `src/shared/password.ts` (from `src/client/features/auth/passwordSchema.ts`, also from `src/routes/_auth.sign-up.tsx`)
- `supabase/migrations/155_f24_signup_guard.sql` (from `src/server/auth/disposable-email.ts`)
- `src/shared/schedule.ts`
- `src/shared/schedule.test.ts`
- `src/server/schedules/runDue.ts`
- `src/server/schedules/runDue.test.ts`
- `src/components/auth/useGoogleAuth.ts` (from `src/client/features/auth/useGoogleAuth.ts`)
- `src/components/auth/TurnstileWidget.tsx` (from `src/client/features/auth/TurnstileWidget.tsx`)
- `src/components/auth/AuthMethodChooser.tsx` (from `src/client/features/auth/AuthMethodChooser.tsx`)
- `src/components/auth/TermsAgreementNotice.tsx` (from `src/client/features/auth/TermsAgreementNotice.tsx`)
- `src/components/auth/GoogleLogo.tsx` (from `src/client/features/auth/GoogleLogo.tsx`)
- `src/components/auth/useRedirectIfSignedIn.ts` (from `src/client/features/auth/useRedirectIfSignedIn.ts`)
- `src/components/auth/SignInForm.tsx` (from `src/routes/_auth.sign-in.tsx`)
- `src/app/login/page.jsx` (from `src/routes/_auth.sign-in.tsx`)
- `src/components/auth/SignUpForm.tsx` (from `src/routes/_auth.sign-up.tsx`)
- `src/app/signup/page.jsx` (from `src/routes/_auth.sign-up.tsx`)
- `src/components/auth/VerifyEmailCard.tsx` (from `src/routes/_auth.verify.tsx`)
- `src/app/auth/verify/page.jsx` (from `src/routes/_auth.verify.tsx`)
- `src/components/app/table/DataTable.tsx` (from `src/client/components/table/DataTable.tsx`)
- `src/shared/table/tableSelection.ts` (from `src/client/components/table/tableSelection.ts`)
- `src/shared/table/tableSelection.test.ts` (from `src/client/features/rank-tracking/tableSelection.test.ts`)
- `src/components/app/table/DataTableToolbar.tsx` (from `src/client/components/table/DataTableToolbar.tsx`)
- `src/components/app/table/TableBulkActionBar.tsx` (from `src/client/components/table/TableBulkActionBar.tsx`)
- `src/components/app/table/TablePagination.tsx` (from `src/client/components/table/TablePagination.tsx`)
- `src/components/app/table/SortableHeader.tsx` (from `src/client/components/table/SortableHeader.tsx`)
- `src/components/app/table/ScoreBadge.tsx` (from `src/client/components/table/ScoreBadge.tsx`)
- `src/shared/table/nullSafeSort.ts` (from `src/client/components/table/nullSafeSort.ts`)
- `src/shared/table/nullSafeSort.test.ts` (from `src/client/components/table/nullSafeSort.ts`)
- `src/shared/table/url.ts` (from `src/client/components/table/url.tsx`)
- `src/shared/table/url.test.ts` (from `src/client/components/table/url.test.ts`)
- `src/components/app/table/ExternalUrlCell.tsx` (from `src/client/components/table/url.tsx`)
- `src/components/app/table/ExportToSheetsModal.tsx` (from `src/client/components/table/ExportToSheetsModal.tsx`)
- `src/components/app/MetricsTable.tsx` (from `src/client/components/MetricsTable.tsx`)
- `src/components/app/ExportMenu.tsx` (from `src/client/components/ExportMenu.tsx`)
- `src/shared/export/csv.ts` (from `src/client/lib/csv.ts`)
- `src/shared/export/csv.test.ts` (from `src/client/lib/csv.test.ts`)
- `src/shared/export/clipboard.ts` (from `src/client/lib/clipboard.ts`)
- `src/shared/export/clipboard.test.ts` (from `src/client/lib/clipboard.test.ts`)
- `src/shared/export/download.ts` (from `src/client/lib/download.ts`)
- `src/shared/export/sheetsModalStore.ts` (from `src/client/lib/exportToSheets.ts`)
- `src/shared/export/exportRows.ts` (from `src/client/lib/exportRows.ts`)
- `src/shared/export/exportRows.test.ts` (from `src/client/lib/exportRows.test.ts`)
- `src/components/app/export/useExportRows.ts` (from `src/client/lib/exportRows.ts`)
- `src/components/auth/ForgotPasswordForm.tsx` (from `src/routes/_auth.forgot-password.tsx`)
- `src/app/auth/forgot/page.jsx` (from `src/routes/_auth.forgot-password.tsx`)
- `src/components/auth/ResetPasswordForm.tsx` (from `src/routes/_auth.reset-password.tsx`)
- `src/app/auth/reset/page.jsx` (from `src/routes/_auth.reset-password.tsx`)
- `src/app/auth/error/page.jsx` (from `src/routes/_auth.auth-error.tsx`)
- `src/app/auth/callback/route.js` (from `src/routes/api.auth.callback.ts`)
- `supabase/migrations/085_f10_customer_schedules.sql` (from `src/db/ai-visibility.schema.ts`, `src/server/features/ai-visibility/repositories/AiVisibilityRepository.ts`)
- `src/shared/query/queryClient.ts` (from `src/client/tanstack-db/queryClient.ts`)
- `src/shared/query/queryClient.test.ts` (from `src/client/tanstack-db/queryClient.test.ts`)
- `src/shared/query/errors.ts` (from `src/client/lib/error-messages.ts`)
- `src/shared/query/errors.test.ts` (from `src/client/lib/error-messages.test.ts`)
- `src/components/app/SpendRefusedError.tsx` (from `src/client/features/billing/InsufficientCreditsError.tsx`)
- `src/shared/query/polling.ts` (from `src/client/features/ai-visibility/shared.tsx`)
- `src/shared/query/polling.test.ts` (from `src/client/features/ai-visibility/shared.tsx`)
- `src/components/app/hooks/useServerPacedQuery.ts` (from `src/client/features/ai-visibility/shared.tsx`)
- `src/components/app/hooks/useJobStatus.ts` (from `src/client/features/audit/AuditDetail.tsx`)
- `src/shared/query/optimistic.ts` (from `src/client/features/rank-tracking/useSetKeywordPinned.ts`)
- `src/shared/query/optimistic.test.ts` (from `src/client/features/rank-tracking/useSetKeywordPinned.ts`)
- `src/components/app/hooks/useOptimisticMutation.ts` (from `src/client/features/rank-tracking/useSetKeywordPinned.ts`)
- `src/shared/query/filterSearchParams.ts` (from `src/client/lib/filterSearchParams.ts`)
- `src/shared/query/filterSearchParams.test.ts` (from `src/client/lib/filterSearchParams.ts`)
- `src/shared/query/urlState.ts` (from `src/routes/_app/p/$projectId/saved.tsx`)
- `src/shared/query/urlState.test.ts` (from `src/routes/_app/p/$projectId/saved.tsx`)
- `src/components/app/hooks/useUrlSearchState.ts` (from `src/routes/_app/p/$projectId/saved.tsx`)
- `src/components/app/hooks/useDebouncedDraft.ts` (from `src/client/hooks/useDebouncedDraft.ts`)
- `src/components/app/hooks/useDebouncedFilters.ts` (from `src/routes/_app/p/$projectId/saved.tsx`)
- `src/shared/query/localPrefs.ts` (from `src/client/features/keywords/hooks/usePreferredKeywordLocation.ts`)
- `src/shared/query/localPrefs.test.ts` (from `src/client/features/keywords/hooks/usePreferredKeywordLocation.ts`)
- `src/components/app/hooks/useLocalPref.ts` (from `src/client/features/keywords/hooks/usePreferredKeywordLocation.ts`)
- `src/shared/query/searchTabsState.ts` (from `src/client/features/search-tabs/useSearchTabs.ts`)
- `src/shared/query/searchTabsState.test.ts` (from `src/client/features/search-tabs/useSearchTabs.test.ts`)
- `src/components/app/search-tabs/useSearchTabs.ts` (from `src/client/features/search-tabs/useSearchTabs.ts`)
- `src/components/app/search-tabs/useSearchTabNavigation.ts` (from `src/client/features/search-tabs/useSearchTabNavigation.ts`)
- `src/components/app/search-tabs/SearchTabStrip.tsx` (from `src/client/features/search-tabs/SearchTabStrip.tsx`)
- `src/shared/json.ts` (from `src/shared/json.ts`)
- `src/shared/providers/loops/client.ts` (from `src/server/email/loops-client.ts`, `src/server/email/loops.ts`, `src/server/billing/loops-sync.ts`)
- `src/shared/query/localHistory.ts` (from `src/client/hooks/useLocalHistoryStore.ts`)
- `src/shared/query/localHistory.test.ts` (from `src/client/hooks/useLocalHistoryStore.ts`)
- `src/components/app/hooks/useLocalHistoryStore.ts` (from `src/client/hooks/useLocalHistoryStore.ts`)
- `src/components/app/hooks/useTimestampedSearchHistory.ts` (from `src/client/hooks/useTimestampedSearchHistory.ts`)
- `src/components/app/RecentSearches.tsx` (from `src/client/components/RecentSearches.tsx`)
- `src/components/app/PrefetchLink.tsx` (from `src/router.tsx`)
- `src/server/schedules/aiVisibilitySchedules.ts` (from `src/server/features/ai-visibility/services/scheduledAiVisibility.ts`, `AiVisibilityRepository.ts`)
- `src/server/schedules/aiVisibilitySchedules.jobs.ts` (from `src/server/features/ai-visibility/services/scheduledAiVisibility.ts`)
- `src/server/schedules/customerSchedule.ts` (from `src/server/features/ai-visibility/services/aiVisibilitySchedule.ts`)
- `src/app/api/customer/schedule/route.ts` (from `src/server/features/ai-visibility/services/aiVisibilitySchedule.ts`)
- `src/components/portal/schedule/ScheduleField.tsx` (from `src/client/features/rank-tracking/ScheduleField.tsx`, `scheduleTime.ts`)
- `src/components/portal/schedule/ScheduleSummary.tsx` (from `src/client/features/ai-visibility/TrackingScheduleSummary.tsx`)

- `src/server/questions/workspaceQuestions.ts` (from `src/shared/ai-prompt-suggestions.ts`)
- `src/server/questions/applyQuestionPatch.ts` (from `src/server/features/ai-visibility/services/aiVisibilityConfiguration.ts`)
- `src/server/questions/applyQuestionPatch.test.ts` (cases ported from `src/server/features/ai-visibility/services/aiVisibilityConfiguration.test.ts`)
- `src/server/questions/panel.ts` (from `src/shared/ai-prompt-suggestions.ts`)
- `src/server/questions/state.ts` (from `src/server/features/ai-visibility/services/aiResearchKeywords.ts`)
- `src/server/questions/tools.ts` (from `src/server/features/ai-visibility/services/aiVisibilityConfiguration.ts`)
- `src/server/questions/jobs.ts`
- `src/server/questions/questions.contract.ts`
- `src/app/api/customer/questions/route.ts`
- `src/app/api/customer/questions/approve/route.ts`
- `src/server/questions/setup/readSite.ts` (from `src/server/lib/scrape.ts`)
- `src/server/questions/setup/promptgenSource.ts` (from `src/server/features/ai-visibility/services/promptGen.ts`)
- `src/server/questions/setup/prompts.ts`
- `src/server/questions/setup/schemas.ts`
- `src/server/questions/setup/research.ts` (from `src/server/features/projects/services/websiteResearch.ts`)
- `src/server/questions/setup/candidates.ts` (from `src/server/features/ai-visibility/services/websiteTrackingSetup.ts`)
- `src/server/questions/setup/save.ts` (from `src/server/features/projects/services/ProjectWebsiteService.ts`, `websiteTrackingSetup.ts`)
- `src/server/questions/generate.ts` (from `src/server/features/ai-visibility/services/aiPromptSuggestions.ts`)
- `src/server/questions/promptResearch.ts` (from `src/server/features/ai-visibility/services/aiPromptResearch.ts`)
- `src/app/api/customer/questions/setup/route.ts`
- `src/app/api/customer/questions/setup/save/route.ts`
- `src/app/api/customer/questions/generate/route.ts`
- `src/app/api/customer/questions/research/route.ts`
- `src/app/api/customer/questions/research/keywords/route.ts`
- `src/shared/audit-fetch-class.ts` (from `src/shared/audit-fetch-class.ts`)
- `src/shared/audit-issues.ts` (from `src/shared/audit-issues.ts`)
- `src/shared/audit-limits.ts` (from `src/shared/audit-limits.ts`)
- `src/shared/lighthouse.ts` (from `src/shared/lighthouse.ts`)
- `src/server/audit/classifyFetch.ts` (from `src/server/lib/audit/classify-fetch.ts`)
- `src/server/audit/crawlThrottle.ts` (from `src/server/lib/audit/crawl-throttle.ts`)
- `src/server/audit/crawlWindow.ts` (from `src/server/lib/audit/crawl-window.ts`)
- `src/server/audit/discovery.ts` (from `src/server/lib/audit/discovery.ts`)
- `src/server/audit/fetchPage.ts` (from `src/server/workflows/site-audit-workflow-helpers.ts`)
- `src/server/audit/htmlResponse.ts` (from `src/server/lib/audit/html-response.ts`)
- `src/server/audit/hreflang.ts`
- `src/server/audit/ids.ts` (from `src/server/lib/audit/ids.ts`)
- `src/server/audit/issues/multipageChecks.ts` (from `src/server/lib/audit/issues/multipage-checks.ts`)
- `src/server/audit/issues/pageReporters.ts` (from `src/server/lib/audit/issues/page-reporters.ts`)
- `src/server/audit/pageAnalyzer.ts` (from `src/server/lib/audit/page-analyzer.ts`)
- `src/server/audit/robotsFile.ts` (from `src/server/lib/audit/discovery.ts`)
- `src/server/audit/structuredData.ts`
- `src/server/audit/types.ts` (from `src/server/lib/audit/types.ts`)
- `src/server/audit/urlPolicy.ts` (from `src/server/lib/audit/url-policy.ts`)
- `src/server/audit/urlUtils.ts` (from `src/server/lib/audit/url-utils.ts`)
- `tests/fixtures/site-audit/types.ts` (from `tests/badseo/src/fixtures/types.ts`)
- `tests/fixtures/site-audit/sites.ts`
- `tests/fixtures/site-audit/fixtures/content.ts` (from `tests/badseo/src/fixtures/content.ts`)
- `tests/fixtures/site-audit/fixtures/head-tags.ts` (from `tests/badseo/src/fixtures/head-tags.ts`)
- `tests/fixtures/site-audit/fixtures/helpers.ts` (from `tests/badseo/src/fixtures/helpers.ts`, `tests/badseo/src/lib.ts`)
- `tests/fixtures/site-audit/fixtures/http-status.ts` (from `tests/badseo/src/fixtures/http-status.ts`)
- `tests/fixtures/site-audit/fixtures/indexability.ts` (from `tests/badseo/src/fixtures/indexability.ts`)
- `tests/fixtures/site-audit/fixtures/kitchen-sink.ts` (from `tests/badseo/src/fixtures/kitchen-sink.ts`)
- `tests/fixtures/site-audit/fixtures/performance.ts` (from `tests/badseo/src/fixtures/performance.ts`)
- `tests/fixtures/site-audit/fixtures/redirects.ts` (from `tests/badseo/src/fixtures/redirects.ts`)
- `tests/fixtures/site-audit/fixtures/structure.ts` (from `tests/badseo/src/fixtures/structure.ts`)
- `src/server/audit/crawlThrottle.test.ts` (from `src/server/lib/audit/crawl-throttle.test.ts`)
- `src/server/audit/crawlWindow.test.ts` (from `src/server/lib/audit/crawl-window.test.ts`)
- `src/server/audit/discovery.test.ts` (from `src/server/lib/audit/discovery.test.ts`)
- `src/server/audit/fetchPage.test.ts` (from `src/server/workflows/site-audit-workflow-helpers.test.ts`)
- `src/server/audit/issues/multipageChecks.test.ts` (from `src/server/lib/audit/issues/multipage-checks.ts`)
- `src/shared/ga4.ts` (from `src/shared/ga4.ts`, `src/shared/google-link.ts`)
- `src/server/ga4/config.ts` (from `src/server/features/google/oauth-config.ts`)
- `src/server/ga4/errors.ts` (from `src/server/lib/ga4Errors.ts`)
- `src/server/ga4/tokens.ts` (from `src/server/features/google/googleOAuth.ts`)
- `src/server/ga4/grants.ts` (from `src/server/features/google/GoogleAccountRepository.ts`)
- `src/server/ga4/accounts.ts` (from `src/server/features/google/GoogleAccountService.ts`, `googleDataRetention.ts`)
- `src/server/ga4/oauth.ts` (from `src/server/features/google/googleOAuth.ts`)
- `src/server/ga4/client.ts` (from `src/server/lib/ga4Client.ts`)
- `src/server/ga4/connection.ts` (from `src/server/features/ga4/services/Ga4Service.ts`, `src/server/features/ga4/repositories/Ga4ConnectionRepository.ts`)
- `src/server/ga4/client.test.ts` (from `src/server/lib/ga4Client.test.ts`)
- `src/components/portal/settings/integrations/Ga4ConnectionCard.tsx` (from `src/client/features/integrations/GoogleConnectionCard.tsx`)
- `src/components/portal/settings/integrations/Ga4PropertyPicker.tsx` (from `src/client/features/integrations/GooglePropertyPicker.tsx`)
- `src/components/portal/settings/integrations/Ga4LinkErrorAlert.tsx` (from `src/client/features/integrations/googleAuthErrorCopy.ts`)
- `src/components/portal/settings/integrations/GoogleAccountRemovalDialog.tsx` (from `src/client/features/integrations/GoogleAccountRemovalDialog.tsx`)
- `src/shared/indexnow.ts` (from `src/client/features/settings/IndexNowSettings.tsx`)
- `src/server/indexnow/keys.ts` (from `src/server/features/indexnow/services/IndexNowService.ts`)
- `src/server/indexnow/keyFile.ts` (from `src/server/features/indexnow/services/IndexNowService.ts`)
- `src/server/indexnow/submit.ts` (from `src/server/features/indexnow/services/IndexNowService.ts`)
- `src/components/portal/indexnow/IndexNowPanel.tsx` (from `src/client/features/settings/IndexNowSettings.tsx`)
- `src/components/portal/indexnow/IndexNowSettings.tsx` (from `src/client/features/settings/IndexNowSettings.tsx`)
- `src/components/portal/indexnow/KeyFileStep.tsx` (from `src/client/features/settings/IndexNowSettings.tsx`)
- `src/components/portal/indexnow/SubmissionHistory.tsx` (from `src/client/features/settings/IndexNowSettings.tsx`)
- `src/components/portal/indexnow/SubmitUrlsForm.tsx` (from `src/client/features/settings/IndexNowSettings.tsx`)
- `scripts/qa/check-f19-db.mjs` (from `src/server/features/projects/repositories/ProjectRepository.ts`)
- `src/components/app/cost/usePriceQuote.ts` (from `src/client/features/ai-visibility/TrackingCostReview.tsx`)
- `src/components/app/cost/CostReviewDialog.tsx` (from `src/client/features/ai-visibility/TrackingCostReview.tsx`, `TrackerSetupReview.tsx`)
- `src/components/app/cost/MonthlyProjection.tsx` (from `src/client/features/ai-visibility/TrackerSetupReview.tsx`)
- `src/components/portal/context/ProjectContextPage.tsx` (from `src/client/features/projects/project-context/ProjectContextPage.tsx`)
- `src/components/portal/context/ProseSections.tsx` (from `src/client/features/projects/project-context/ProjectContextPage.tsx`)
- `src/components/portal/context/CustomSections.tsx` (from `src/client/features/projects/project-context/ProjectContextPage.tsx`)
- `src/components/portal/context/ResearchLog.tsx` (from `src/client/features/projects/project-context/ProjectContextPage.tsx`)
- `src/components/portal/context/CompetitorsSection.tsx` (from `src/client/features/projects/project-context/CompetitorsSection.tsx`)
- `src/components/portal/context/KeyPagesSection.tsx` (from `src/client/features/projects/project-context/KeyPagesSection.tsx`)
- `src/components/portal/context/EditableListSection.tsx` (from `src/client/features/projects/project-context/EditableListSection.tsx`)
- `src/components/portal/context/Provenance.tsx` (from `src/client/features/projects/project-context/shared.tsx`)
- `src/components/portal/context/hooks/useProjectContext.ts` (from `src/client/features/projects/project-context/shared.tsx`)
- `src/components/portal/context/editableList.ts` (from `src/client/features/projects/project-context/EditableListSection.tsx`)
- `src/components/portal/context/editableList.test.ts` (from `src/client/features/projects/project-context/EditableListSection.test.ts`)
- `src/server/email/sweeps.ts` (from `src/server/features/audit/services/firstAuditEmails.ts`, `src/server/email/onboarding-drip.ts`)
- `src/server/email/spendCap.ts` (from `src/server/email/onboarding-drip.ts`)
- `src/server/email/signup.ts` (from `src/server/email/loops.ts`)

- `src/server/audit/store.ts` (from `src/server/features/audit/AuditScratchpad.ts`, `src/server/features/audit/AuditRepository.ts`)
- `src/server/audit/memoryStore.ts` (from `src/server/features/audit/AuditScratchpad.ts`, `src/server/features/audit/AuditRepository.ts`)
- `src/server/audit/store.test.ts` (from `src/server/features/audit/AuditScratchpad.test.ts`)
- `src/server/audit/job.ts` (from `src/server/workflows/SiteAuditWorkflow.ts`, `src/server/workflows/auditStepConfigs.ts`)
- `src/server/audit/job.test.ts` (from `src/server/workflows/SiteAuditWorkflow.test.ts`)
- `src/server/audit/crawlPhase.ts` (from `src/server/workflows/siteAuditWorkflowCrawl.ts`)
- `src/server/audit/crawlPhase.test.ts` (from `src/server/workflows/siteAuditWorkflowCrawl.test.ts`)
- `src/server/audit/phases.ts` (from `src/server/workflows/siteAuditWorkflowPhases.ts`)
- `src/server/audit/errors.ts` (from `src/server/lib/audit/audit-errors.ts`)
- `src/server/audit/reconcile.ts` (from `src/server/features/audit/auditReconciler.ts`)
- `src/server/audit/reconcile.test.ts` (from `src/server/features/audit/auditReconciler.test.ts`)
- `src/server/audit/issues/multipage.ts` (from `src/server/lib/audit/issues/multipage.ts`)
- `src/server/audit/cancel.ts` (from `src/server/features/audit/services/AuditService.ts`)
- `src/server/audit/retention.ts` (from `src/server/workflows/SiteAuditWorkflow.ts`)
- `src/server/audit/retention.test.ts` (from `src/server/workflows/SiteAuditWorkflow.test.ts`)
- `src/server/audit/telemetry.ts` (from `src/server/features/audit/telemetry.ts`)
- `scripts/qa/check-f18-db.mjs` (from `src/server/features/audit/AuditScratchpad.test.ts`)
- `src/server/audit/crawlerAccess.ts` (from `src/shared/crawler-access.ts`, `src/server/features/audit/services/CrawlerCredentialService.ts`, `src/server/features/audit/repositories/CrawlerCredentialRepository.ts`)
- `src/server/audit/shopifySignature.ts` (from `src/server/features/audit/services/shopifySignature.ts`)
- `src/server/audit/crawlerAccess.test.ts` (from `src/shared/crawler-access.test.ts`, `src/server/features/audit/services/CrawlerCredentialService.test.ts`, `src/server/features/audit/services/AuditService.crawlerAccess.test.ts`)
- `src/components/portal/audit/crawlerAccess/ShopifyCrawlWarning.tsx` (from `src/client/features/audit/results/ShopifyCrawlWarning.tsx`)
- `src/shared/providers/dataforseo/client.ts`
- `src/shared/providers/dataforseo/client.test.ts`
- `src/shared/providers/dataforseo/serp.ts`
- `src/shared/providers/dataforseo/serp.test.ts`
- `src/shared/providers/dataforseo/index.ts`
- `src/shared/providers/dataforseo/labs.ts` (from `src/server/lib/dataforseo/labs.ts`)
- `src/shared/providers/dataforseo/google-ads.ts` (from `src/server/lib/dataforseo/google-ads.ts`)
- `src/shared/providers/dataforseo/keyword-metrics.ts` (from `src/server/lib/dataforseo/keyword-metrics.ts`)
- `src/shared/providers/dataforseo/keyword-metrics.test.ts` (from `src/server/lib/dataforseo/keyword-metrics.test.ts`)
- `src/shared/providers/dataforseo/filters.ts` (from `src/server/lib/dataforseo/filters.ts`)
- `src/shared/providers/dataforseo/researchScopeFilters.ts` (from `src/server/lib/dataforseo/researchScopeFilters.ts`)
- `src/server/research/target.ts` (from `src/server/lib/domainUtils.ts`)
- `src/shared/researchScope.ts` (from `src/shared/researchScope.ts`)
- `src/shared/keyword-locations.ts` (from `src/shared/keyword-locations.ts`)
- `src/shared/keywords.ts` (from `src/shared/keywords.ts`)
- `src/shared/keyword-filtering.ts` (from `src/shared/keyword-filtering.ts`)
- `src/shared/saved-keyword-tags.ts` (from `src/shared/saved-keyword-tags.ts`)
- `src/shared/tag-colors.ts` (from `src/shared/tag-colors.ts`)
- `src/shared/saved-keywords-filters.ts` (from `src/shared/saved-keywords-filters.ts`)
- `src/components/app/ResearchScopeSelect.tsx` (from `src/client/components/ResearchScopeSelect.tsx`)
- `src/components/app/SearchCard.tsx` (from `src/client/components/SearchCard.tsx`)
- `src/app/api/customer/keywords/research/route.ts` (from `src/serverFunctions/keywords.ts`)
- `src/app/api/customer/keywords/serp/route.ts` (from `src/serverFunctions/serp-locations.ts`)
- `src/server/keywords/helpers.ts` (from `src/server/features/keywords/services/research/helpers.ts`)
- `src/server/keywords/keywords.contract.ts` (from `src/types/schemas/keywords.ts`)
- `src/server/keywords/research.ts` (from `src/server/features/keywords/services/research/research.ts`)
- `src/server/keywords/research.test.ts` (from `src/server/features/keywords/services/research/research.test.ts`)
- `src/server/keywords/researchData.ts` (from `src/server/features/keywords/services/research/research-data.ts`)
- `src/server/keywords/selection.ts` (from `src/server/features/keywords/services/research/selection.ts`)
- `src/server/keywords/serp.ts` (from `src/server/features/keywords/services/research/serp.ts`)
- `src/server/keywords/serp.test.ts` (from `src/server/features/keywords/services/research/serp.test.ts`)
- `src/server/keywords/tools.ts` (from `src/server/mcp/tools/`)
- `src/app/api/customer/keywords/saved/route.ts` (from `src/serverFunctions/keywords.ts`, `src/server/features/keywords/services/research/saved-keywords.ts`)
- `src/app/api/customer/keywords/saved/remove/route.ts` (from `src/server/features/keywords/services/research/saved-keywords.ts`)
- `src/app/api/customer/keywords/saved/tags/route.ts` (from `src/server/features/keywords/services/research/saved-keywords.ts`)
- `src/app/api/customer/keywords/tags/[tagId]/route.ts` (from `src/server/features/keywords/services/research/saved-keywords.ts`)
- `src/app/api/customer/keywords/saved/export/route.ts` (from `src/serverFunctions/keywords.ts`, `src/server/features/keywords/services/research/saved-keywords.ts`)
- `src/shared/providers/dataforseo/serp-locations.ts` (from `src/server/lib/dataforseo/serp-locations.ts`)
- `src/shared/serp-location-search.ts` (from `src/shared/serp-location-search.ts`)
- `src/server/keywords/localVolume.ts` (from `src/server/features/keywords/services/research/local-volume.ts`)
- `src/app/api/customer/keywords/locations/route.ts` (from `src/serverFunctions/serp-locations.ts`)
- `src/shared/serp-location-search.test.ts` (from `src/shared/serp-location-search.test.ts`)
- `src/server/keywords/localVolume.test.ts` (from `src/server/features/keywords/services/research/research.test.ts`)
- `src/components/portal/keywords/research/SerpLocationCombobox.tsx` (from `src/client/components/SerpLocationCombobox.tsx`)
- `src/components/portal/keywords/research/usePrewarmSerpLocations.tsx` (from `src/client/components/usePrewarmSerpLocations.ts`)
- `src/components/portal/keywords/research/KeywordAreaField.tsx` (from `src/client/features/keywords/page/KeywordAreaField.tsx`)
- `src/app/api/customer/keywords/saved/refresh/route.ts` (from `src/server/features/keywords/services/research/refresh-metrics.ts`)
- `src/server/keywords/repository.ts` (from `src/server/features/keywords/repositories/KeywordResearchRepository.ts`, `src/server/features/keywords/repositories/SavedKeywordTagsRepository.ts`)
- `src/server/keywords/memoryRepository.ts` (from `src/server/features/keywords/repositories/KeywordResearchRepository.ts`, `src/server/features/keywords/repositories/SavedKeywordTagsRepository.ts`)
- `src/server/keywords/savedKeywords.ts` (from `src/server/features/keywords/services/research/saved-keywords.ts`)
- `src/server/keywords/refreshMetrics.ts` (from `src/server/features/keywords/services/research/refresh-metrics.ts`)
- `src/server/keywords/jobs.ts` (from `src/server/features/keywords/services/research/refresh-metrics.ts`, `src/server/workflows/auditStepConfigs.ts`)
- `src/server/domain/domain.contract.ts` (from `src/types/schemas/domain.ts`)
- `src/server/domain/domainKeywordFilters.ts` (from `src/server/features/domain/services/domainKeywordFilters.ts`)
- `src/server/domain/domainKeywordMapper.ts` (from `src/server/features/domain/services/domainKeywordMapper.ts`)
- `src/server/domain/domainPagesFilters.ts` (from `src/server/features/domain/services/domainPagesPage.ts`)
- `src/server/domain/domainService.ts` (from `src/server/features/domain/services/DomainService.ts`, `domainKeywordsPage.ts`, `domainPagesPage.ts`)
- `src/server/domain/pagination.ts` (from `src/server/features/domain/services/pagination.ts`)
- `src/shared/pricing/actions/domain.ts` (from `src/serverFunctions/domain.ts`)
- `src/server/domain/serpCompetitors.ts` (from `src/server/mcp/tools/dataforseo-research-tools.ts`)

- `src/shared/providers/dataforseo/backlinks.ts` (from `src/server/lib/dataforseo/backlinks.ts`)
- `src/shared/providers/dataforseo/backlinks.test.ts` (from `src/server/lib/dataforseo/backlinks.test.ts`)
- `src/shared/providers/dataforseo/backlinksTarget.ts` (from `src/server/lib/dataforseoBacklinksTarget.ts`)
- `src/shared/providers/dataforseo/backlinksTarget.test.ts` (from `src/server/lib/dataforseo/backlinks.test.ts`)
- `src/shared/providers/dataforseo/business.ts` (from `src/server/lib/dataforseo/business.ts`)
- `src/shared/providers/dataforseo/business.test.ts` (from `src/server/lib/dataforseo/business.test.ts`)
- `src/server/local/shared.ts` (from `src/server/mcp/tools/local-seo-shared.ts`, `src/server/mcp/table.ts`, `src/server/mcp/tools/dataforseo-research-tools.ts`)
- `src/server/local/shared.test.ts` (from `src/server/mcp/tools/local-seo-tools.test.ts`)
- `src/server/local/rowFields.ts` (from `src/server/mcp/tools/dataforseo-research-tools.ts`, `src/server/mcp/tools/local-seo-tools.ts`)
- `src/server/local/rowFields.test.ts` (from `src/server/mcp/tools/dataforseo-research-tools.ts`, `src/server/mcp/tools/local-seo-tools.ts`)
- `src/server/local/grid.ts` (from `src/server/mcp/tools/local-seo-tools.ts`)
- `src/server/local/grid.test.ts` (from `src/server/mcp/tools/local-seo-tools.test.ts`)
- `src/shared/backlinks.ts` (from `src/types/schemas/backlinks.ts`, `src/client/features/backlinks/backlinksFilterTypes.ts`, `src/client/features/backlinks/backlinksPageUtils.ts`, `src/client/features/backlinks/export.ts`, `src/client/features/backlinks/backlinksPageTypes.ts`)
- `src/server/backlinks/backlinksApiFilters.ts` (from `src/server/features/backlinks/services/backlinksApiFilters.ts`)
- `src/server/backlinks/backlinksOverviewSchema.ts` (from `src/server/features/backlinks/services/backlinksOverviewSchema.ts`)
- `src/server/backlinks/backlinksRowMappers.ts` (from `src/server/features/backlinks/services/backlinksRowMappers.ts`)
- `src/server/backlinks/backlinksSubfolderOverview.ts` (from `src/server/features/backlinks/services/backlinksSubfolderOverview.ts`)
- `src/server/backlinks/backlinksService.ts` (from `src/server/features/backlinks/services/BacklinksService.ts`, `backlinksServiceData.ts`)
- `src/server/backlinks/backlinks.contract.ts` (from `src/types/schemas/backlinks.ts`)
- `src/server/workers/queuedCollection.js` (from `src/server/features/ai-visibility/services/aiVisibilityCollection.ts`, `src/server/workflows/AiVisibilityWorkflow.ts`)
- `src/shared/engines/dataforseo.ts` (from `src/server/features/ai-visibility/services/aiVisibilityCollection.ts`)
- `src/server/local/profile.ts` (from `src/server/mcp/tools/local-seo-tools.ts`)
- `src/server/local/listings.ts` (from `src/server/mcp/tools/dataforseo-research-tools.ts`, `src/server/mcp/tools/local-seo-tools.ts`)
- `src/server/local/listings.test.ts` (from `src/server/mcp/tools/local-seo-tools.test.ts`)
- `src/server/local/fetches.ts` (from `src/server/mcp/tools/local-seo-tools.ts`, `src/server/mcp/tools/dataforseo-research-tools.ts`)
- `src/server/local/fetches.test.ts` (from `src/server/mcp/tools/local-seo-tools.test.ts`)
- `src/server/local/grid.service.test.ts` (from `src/server/mcp/tools/local-seo-tools.test.ts`)
- `src/server/local/localSerp.ts` (from `src/server/mcp/tools/dataforseo-research-tools.ts`)
- `src/server/local/localSerp.test.ts` (from `src/server/mcp/tools/dataforseo-research-tools.ts`)
- `src/components/portal/backlinks/BacklinksPage.tsx` (from `src/client/features/backlinks/BacklinksPage.tsx`)
- `src/components/portal/backlinks/BacklinksSearchCard.tsx` (from `src/client/features/backlinks/BacklinksSearchCard.tsx`)
- `src/components/portal/backlinks/BacklinksPageContent.tsx` (from `src/client/features/backlinks/BacklinksPageContent.tsx`)
- `src/components/portal/backlinks/BacklinksOverviewPanels.tsx` (from `src/client/features/backlinks/BacklinksOverviewPanels.tsx`)
- `src/components/portal/backlinks/BacklinksPageCharts.tsx` (from `src/client/features/backlinks/BacklinksPageCharts.tsx`)
- `src/components/portal/backlinks/BacklinksPageSections.tsx` (from `src/client/features/backlinks/BacklinksPageSections.tsx`)
- `src/components/portal/backlinks/BacklinksPageStates.tsx` (from `src/client/features/backlinks/BacklinksPageStates.tsx`)
- `src/components/portal/backlinks/BacklinksFilterPanel.tsx` (from `src/client/features/backlinks/BacklinksFilterPanel.tsx`, `src/client/features/domain/components/DomainFilterPanel.tsx`)
- `src/components/portal/backlinks/BacklinksToolbarMenus.tsx` (from `src/client/features/backlinks/BacklinksToolbarMenus.tsx`)
- `src/components/portal/backlinks/BacklinksTable.tsx` (from `src/client/features/backlinks/BacklinksTable.tsx`)
- `src/components/portal/backlinks/BacklinksTableColumns.tsx` (from `src/client/features/backlinks/BacklinksTableColumns.tsx`)
- `src/components/portal/backlinks/ReferringDomainsTable.tsx` (from `src/client/features/backlinks/ReferringDomainsTable.tsx`)
- `src/components/portal/backlinks/TopPagesTable.tsx` (from `src/client/features/backlinks/TopPagesTable.tsx`)
- `src/components/portal/backlinks/hooks/useBacklinksPageData.ts` (from `src/client/features/backlinks/useBacklinksPageData.ts`)
- `src/components/portal/backlinks/hooks/useBacklinksFilters.ts` (from `src/client/features/backlinks/useBacklinksFilters.ts`)
- `src/components/portal/backlinks/hooks/useBacklinksDomainExpansion.ts` (from `src/client/features/backlinks/useBacklinksDomainExpansion.ts`)
- `src/components/portal/backlinks/hooks/useBacklinksSearchHistory.ts` (from `src/client/hooks/useBacklinksSearchHistory.ts`)
- `src/components/portal/backlinks/hooks/useBacklinksSearchTabs.ts` (from `src/client/features/backlinks/useBacklinksPageData.ts`)
- `src/components/portal/backlinks/useAhrefsDomainRatings.ts` (from `src/client/features/backlinks/useAhrefsDomainRatings.ts`)
- `src/shared/domain.ts` (from `src/types/schemas/domain.ts`, `src/client/features/domain/domainRouteState.ts`, `src/client/features/domain/domainFilterUtils.ts`, `src/client/features/domain/utils.ts`, `src/client/features/domain/types.ts`)
- `src/components/portal/domain/DomainFilterPanel.tsx` (from `src/client/features/domain/components/DomainFilterPanel.tsx`)
- `src/components/portal/domain/DomainKeywordsTable.tsx` (from `src/client/features/domain/components/DomainKeywordsTable.tsx`)
- `src/components/portal/domain/DomainOverviewCard.tsx` (from `src/client/features/domain/DomainOverviewPage.tsx`)
- `src/components/portal/domain/DomainOverviewLoadingState.tsx` (from `src/client/features/domain/components/DomainOverviewLoadingState.tsx`)
- `src/components/portal/domain/DomainOverviewPage.tsx` (from `src/client/features/domain/DomainOverviewPage.tsx`)
- `src/components/portal/domain/DomainPageLink.tsx` (from `src/client/features/domain/components/DomainPageLink.tsx`)
- `src/components/portal/domain/DomainPagesTable.tsx` (from `src/client/features/domain/components/DomainPagesTable.tsx`)
- `src/components/portal/domain/DomainSearchCard.tsx` (from `src/client/features/domain/components/DomainSearchCard.tsx`)
- `src/components/portal/domain/DomainTableToolbar.tsx` (from `src/client/features/domain/components/DomainTableToolbar.tsx`)
- `src/components/portal/domain/hooks/useDomainFilterPreferences.ts` (from `src/client/features/domain/useDomainFilterPreferences.ts`)
- `src/components/portal/domain/hooks/useDomainKeywordsQuery.ts` (from `src/client/features/domain/hooks/useDomainKeywordsQuery.ts`)
- `src/components/portal/domain/hooks/useDomainOverviewQuery.ts` (from `src/client/features/domain/hooks/useDomainOverviewQuery.ts`)
- `src/components/portal/domain/hooks/useDomainPagesQuery.ts` (from `src/client/features/domain/hooks/useDomainPagesQuery.ts`)
- `src/components/portal/domain/hooks/useDomainSearchHistory.ts` (from `src/client/hooks/useDomainSearchHistory.ts`)
- `src/components/portal/domain/hooks/useDomainSearchTabs.ts` (from `src/client/features/search-tabs/useSearchTabs.ts`)
- `src/components/portal/domain/KeywordsTab.tsx` (from `src/client/features/domain/components/KeywordsTab.tsx`)
- `src/components/portal/domain/PagesTab.tsx` (from `src/client/features/domain/components/PagesTab.tsx`)
- `src/components/portal/domain/telemetry.ts` (from `src/client/lib/posthog.ts`)
- `src/components/portal/domain/SaveDomainKeywordsDialog.tsx` (from `src/client/features/domain/domainActions.ts`)
- `src/components/portal/domain/CompetitorsTab.tsx` (from `src/client/features/domain/components/KeywordsTab.tsx`)
- `src/components/portal/domain/DomainCompetitorsTable.tsx` (from `src/client/features/domain/components/DomainPagesTable.tsx`)
- `src/components/portal/domain/hooks/useDomainCompetitors.ts` (from `src/client/features/domain/hooks/useDomainKeywordsQuery.ts`)

- `src/components/portal/keywords/research/AreaTrendChart.tsx` (from `openseo:src/client/features/keywords/components/DisplayPrimitives.tsx`)
- `src/components/portal/keywords/research/IntentBadge.tsx` (from `openseo:src/client/features/keywords/components/IntentBadge.tsx`)
- `src/components/portal/keywords/research/KeywordNotLoadedCard.tsx` (from `openseo:src/client/features/keywords/page/KeywordResearchPage.tsx`)
- `src/components/portal/keywords/research/KeywordResearchEmptyState.tsx` (from `openseo:src/client/features/keywords/page/KeywordResearchEmptyState.tsx`)
- `src/components/portal/keywords/research/KeywordResearchFilters.tsx` (from `openseo:src/client/features/keywords/page/keywordResearchFilters.tsx`)
- `src/components/portal/keywords/research/KeywordResearchLoadingState.tsx` (from `openseo:src/client/features/keywords/page/KeywordResearchLoadingState.tsx`)
- `src/components/portal/keywords/research/KeywordResearchPage.tsx` (from `openseo:src/client/features/keywords/page/KeywordResearchPage.tsx`)
- `src/components/portal/keywords/research/KeywordResearchPagination.tsx` (from `openseo:src/client/features/keywords/page/KeywordResearchPagination.tsx`)
- `src/components/portal/keywords/research/KeywordResearchResults.tsx` (from `openseo:src/client/features/keywords/page/KeywordResearchResults.tsx`)
- `src/components/portal/keywords/research/KeywordResearchSearchBar.tsx` (from `openseo:src/client/features/keywords/page/KeywordResearchSearchBar.tsx`)
- `src/components/portal/keywords/research/KeywordResearchTable.tsx` (from `openseo:src/client/features/keywords/page/KeywordResearchTable.tsx`)
- `src/components/portal/keywords/research/KeywordSearchOptions.tsx` (from `openseo:src/client/features/keywords/page/KeywordSearchOptions.tsx`)
- `src/components/portal/keywords/research/OverviewStats.tsx` (from `openseo:src/client/features/keywords/components/KeywordUi.tsx`)
- `src/components/portal/keywords/research/SaveKeywordsDialog.tsx` (from `openseo:src/client/features/keywords/page/KeywordResearchPage.tsx`)
- `src/components/portal/keywords/research/SerpAnalysisCard.tsx` (from `openseo:src/client/features/keywords/components/SerpAnalysisCard.tsx`)
- `src/components/portal/keywords/research/hooks/useKeywordHistory.ts` (from `openseo:src/client/hooks/useTimestampedSearchHistory.ts`)
- `src/components/portal/keywords/research/hooks/useKeywordResearchController.ts` (from `openseo:src/client/features/keywords/state/useKeywordResearchController.ts`, `openseo:src/client/features/keywords/state/keywordControllerActions.ts`, `openseo:src/client/features/keywords/state/keywordControllerInternals.ts`, `openseo:src/client/features/keywords/hooks/useKeywordControlsForm.ts`, `openseo:src/client/features/keywords/state/useKeywordOverviewState.ts`)
- `src/components/portal/keywords/research/hooks/useKeywordResearchData.ts` (from `openseo:src/client/features/keywords/hooks/useKeywordResearchData.ts`)
- `src/components/portal/keywords/research/hooks/useKeywordSearchTabs.ts` (from `openseo:src/client/features/search-tabs/useSearchTabs.ts`, `openseo:src/client/features/keywords/page/KeywordResearchPage.tsx`)
- `src/components/portal/keywords/research/hooks/useKeywordSerpAnalysis.ts` (from `openseo:src/client/features/keywords/hooks/useKeywordSerpAnalysis.ts`)

### F13 Phase 5 ports (saved-keywords page)
- `src/components/portal/keywords/saved/SavedKeywordsPage.tsx` (from `openseo:src/routes/_app/p/$projectId/saved.tsx`, `openseo:src/client/features/saved-keywords/**`)
- `src/components/portal/keywords/saved/SavedKeywordsHeader.tsx` (from `openseo:src/client/features/saved-keywords/**`)
- `src/components/portal/keywords/saved/SavedKeywordsTable.tsx` (from `openseo:src/client/features/saved-keywords/**`)
- `src/components/portal/keywords/saved/SavedKeywordsFilters.tsx` (from `openseo:src/client/features/saved-keywords/**`)
- `src/components/portal/keywords/saved/SavedKeywordsFilterPanel.tsx` (from `openseo:src/client/features/saved-keywords/**`)
- `src/components/portal/keywords/saved/SavedKeywordsTagFilter.tsx` (from `openseo:src/client/features/saved-keywords/**`)
- `src/components/portal/keywords/saved/ManageTagRow.tsx` (from `openseo:src/client/features/saved-keywords/**`)
- `src/components/portal/keywords/saved/TagChip.tsx` (from `openseo:src/client/features/saved-keywords/**`)
- `src/components/portal/keywords/saved/SavedKeywordsBulkActionBar.tsx` (from `openseo:src/client/features/saved-keywords/**`)
- `src/components/portal/keywords/saved/SavedKeywordsBulkTagsModal.tsx` (from `openseo:src/client/features/saved-keywords/**`)
- `src/components/portal/keywords/saved/SavedKeywordsModals.tsx` (from `openseo:src/client/features/saved-keywords/**`)
- `src/components/portal/keywords/saved/RefreshStatsStatus.tsx` (from `openseo:src/client/features/saved-keywords/**`)
- `src/components/portal/keywords/saved/hooks/useSavedKeywordsQuery.ts` (from `openseo:src/routes/_app/p/$projectId/saved.tsx`, `openseo:src/client/features/saved-keywords/**`)
- `src/components/portal/keywords/saved/hooks/useSavedKeywordsExport.ts` (from `openseo:src/client/features/saved-keywords/**`)
- `src/components/portal/keywords/saved/hooks/useTagManage.ts` (from `openseo:src/client/features/saved-keywords/**`)
- `src/components/portal/keywords/saved/hooks/useRefreshStats.ts` (from `openseo:src/client/features/saved-keywords/**`)

### F03 Phase 4 ports
- `src/components/portal/usage/hooks/useUsage.ts` (from `src/client/features/billing/useBillingUsage.ts`)
- `src/components/portal/usage/UsageChart.tsx` (from `src/client/features/billing/BillingUsageChart.tsx`)
- `src/components/portal/usage/UsageByFeature.tsx` (from `src/client/features/billing/BillingFeatureBreakdown.tsx`)
- `src/components/portal/usage/UsageSection.tsx` (from `src/client/features/billing/BillingUsageSection.tsx`)

### F15 Phase 1 ports
- src/shared/rank-tracking.ts
- src/shared/rank-tracking-filters.ts
- src/shared/google-serp-url.ts
- src/shared/rank-tracking/cost.ts
- src/shared/rank-tracking/market.ts
- src/shared/rank-tracking/retries.ts
- src/shared/rank-tracking/schedules.ts
- src/shared/rank-tracking/repository.ts
- src/shared/rank-tracking/memoryRepository.ts
- supabase/migrations/110_f15_rank_tracking.sql
- supabase/migrations/111_f15_rank_tracking_functions.sql
- src/shared/rank-tracking.test.ts
- src/shared/rank-tracking-filters.test.ts
- src/shared/google-serp-url.test.ts
- src/shared/rank-tracking/cost.test.ts
- src/shared/rank-tracking/retries.test.ts
- src/shared/rank-tracking/schedules.test.ts

### F06 Phase 3 ports
- src/shared/export/serverCsv.ts (from `src/server/features/ai-visibility/services/aiVisibilityExport.ts`)
- src/shared/export/serverExport.ts (from `src/server/features/ai-visibility/services/aiVisibilityExport.ts`)
- src/shared/export/kinds/workspaceAnswers.ts (from `src/server/features/ai-visibility/services/aiVisibilityExport.ts`)
- src/shared/export/kinds/siteAudit.ts (from `src/client/features/audit/results/export.ts`)
- src/app/api/customer/exports/route.ts (from `src/server/features/ai-visibility/services/aiVisibilityExport.ts`)

### F08 Phase 4 ports
- `src/components/portal/questions/AddQuestionsDialog.tsx` (from `openseo:src/client/features/ai-visibility/TrackerEditor.tsx`)
- `src/components/portal/questions/QuestionFields.tsx` (from `openseo:src/client/features/ai-visibility/TrackerPromptFields.tsx`)
- `src/components/portal/questions/TopicField.tsx` (from `openseo:src/client/features/ai-visibility/TopicField.tsx`)
- `src/components/portal/questions/setup/QuestionSetupGate.tsx` (from `openseo:src/client/features/ai-visibility/AiResearchSetupGate.tsx`)
- `src/components/portal/questions/setup/SetupReview.tsx` (from `openseo:src/client/features/projects/WebsiteSetupReview.tsx`)
- `src/components/portal/questions/setup/CompetitorRow.tsx` (from `openseo:src/client/features/projects/WebsiteCompetitorRow.tsx`)
- `src/components/portal/questions/research/QuestionResearchTable.tsx` (from `openseo:src/client/features/ai-visibility/PromptResearchTable.tsx`)

### F18 Phase 4 ports
- `src/components/portal/audit/AuditDetail.tsx` (from `openseo:src/client/features/audit/AuditDetail.tsx`, `openseo:src/client/features/audit/shared.tsx`)
- `src/components/portal/audit/ProgressCard.tsx` (from `openseo:src/client/features/audit/AuditDetail.tsx`)
- `src/components/portal/audit/CrawlFeed.tsx` (from `openseo:src/client/features/audit/AuditDetail.tsx`)
- `src/components/portal/audit/AuditBanners.tsx` (from `openseo:src/client/features/audit/results/ResultsView.tsx`, `openseo:src/client/features/audit/RenderingWarnings.tsx`, `openseo:src/client/features/audit/shared.tsx`)
- `src/components/portal/audit/shared.tsx` (from `openseo:src/client/features/audit/shared.tsx`)
- `src/components/portal/audit/AuditPage.tsx` (from `openseo:src/routes/_app/p/$projectId/audit/index.tsx`)
- `src/components/portal/audit/launch/LaunchView.tsx` (from `openseo:src/client/features/audit/launch/LaunchView.tsx`)
- `src/components/portal/audit/launch/LaunchFormCard.tsx` (from `openseo:src/client/features/audit/launch/LaunchFormCard.tsx`)
- `src/components/portal/audit/launch/AuditHistoryTable.tsx` (from `openseo:src/client/features/audit/launch/AuditHistorySection.tsx`)
- `src/components/portal/audit/launch/useLaunchController.ts` (from `openseo:src/client/features/audit/launch/useLaunchController.ts`)
- `src/components/portal/audit/results/ResultsView.tsx` (from `openseo:src/client/features/audit/results/ResultsView.tsx`)
- `src/components/portal/audit/results/StatsStrip.tsx` (from `openseo:src/client/features/audit/results/ResultsView.tsx`)
- `src/components/portal/audit/results/IssuesView.tsx` (from `openseo:src/client/features/audit/results/IssuesView.tsx`)
- `src/components/portal/audit/results/IssueDetails.tsx` (from `openseo:src/client/features/audit/results/IssuesView.tsx`)
- `src/components/portal/audit/results/PagesTable.tsx` (from `openseo:src/client/features/audit/results/PagesTable.tsx`, `openseo:src/client/features/audit/results/AuditResultsTableFilters.tsx`)
- `src/components/portal/audit/results/PagesFilters.tsx` (from `openseo:src/client/features/audit/results/AuditResultsTableFilters.tsx`)
- `src/components/portal/audit/results/PerformanceTable.tsx` (from `openseo:src/client/features/audit/results/ResultsTables.tsx`)
- `src/components/portal/audit/results/export.ts` (from `openseo:src/client/features/audit/results/export.ts`)
- `src/app/portal/audit/page.tsx` (from `openseo:src/routes/_app/p/$projectId/audit/index.tsx`)
- `src/app/portal/audit/[auditId]/page.tsx` (from `openseo:src/routes/_app/p/$projectId/audit/index.tsx`)

### F20 Phase 3 ports
- `src/server/ga4/dates.ts` (from `openseo:src/server/features/ga4/services/Ga4Dates.ts`)
- `src/server/ga4/reportDefinitions.ts` (from `openseo:src/server/features/ga4/services/Ga4ReportDefinitions.ts`)
- `src/server/ga4/normalization.ts` (from `openseo:src/server/features/ga4/services/Ga4ReportNormalization.ts`)
- `src/server/ga4/enhancements.ts` (from `openseo:src/server/features/ga4/services/Ga4ReportEnhancements.ts`)
- `src/server/ga4/reporting.ts` (from `openseo:src/server/features/ga4/services/Ga4ReportingService.ts`)
- `src/server/ga4/overview.ts` (from `openseo:src/server/features/ga4/services/Ga4OrganicOverviewService.ts`)
- `src/server/ga4/measurementHealth.ts` (from `openseo:src/server/features/ga4/services/Ga4MeasurementHealthService.ts`)
- `src/server/ga4/reportDefinitions.test.ts` (from `openseo:src/server/features/ga4/services/Ga4ReportDefinitions.ts`)
- `src/server/ga4/normalization.test.ts` (from `openseo:src/server/features/ga4/services/Ga4ReportNormalization.ts`)
- `src/server/ga4/enhancements.test.ts` (from `openseo:src/server/features/ga4/services/Ga4ReportEnhancements.test.ts`)
- `src/server/ga4/reporting.test.ts` (from `openseo:src/server/features/ga4/services/Ga4ReportingService.test.ts`)
- `src/server/ga4/overview.test.ts` (from `openseo:src/server/features/ga4/services/Ga4OrganicOverviewService.test.ts`)
- `src/server/ga4/measurementHealth.test.ts` (from `openseo:src/server/features/ga4/services/Ga4MeasurementHealthService.test.ts`)

### F20 Phase 4 ports
- `src/server/ga4/gscPages.ts` (from `openseo:src/server/features/ga4/services/SearchOpportunityService.ts` (GSC half))
- `src/server/ga4/opportunities.ts` (from `openseo:src/server/features/ga4/services/SearchOpportunityService.ts`)
- `src/server/ga4/opportunities.test.ts` (from `openseo:src/server/features/ga4/services/SearchOpportunityService.test.ts:68-202`)
- `src/app/api/customer/ga4/opportunities/route.ts` (from `openseo:src/serverFunctions/ga4.ts`, `openseo:src/server/features/ga4/services/SearchOpportunityService.ts:246-290`)

### F13 Phase 6 ports
- `src/server/keywords/clustering.ts` (ideas only from `openseo:.agents/skills/keyword-clustering/SKILL.md`)
- `src/app/api/customer/keywords/cluster/route.ts` (from `openseo:src/serverFunctions/keywords.ts`)


### F18 Phase 5 ports
- src/shared/providers/dataforseo/lighthouse.ts (from src/server/lib/dataforseo/lighthouse.ts)
- src/server/audit/lighthouse.ts (from src/server/lib/audit/lighthouse.ts)
- src/server/audit/lighthousePayload.ts (from src/server/lib/lighthousePayload.ts, src/server/lib/lighthouseStoredPayload.ts, src/server/lib/dataforseoLighthousePayload.ts)
- src/shared/providers/dataforseo/lighthouse.test.ts (from src/server/lib/dataforseo/lighthouse.test.ts)
- src/server/audit/lighthouse.test.ts (from src/server/lib/audit/lighthouse.test.ts)
- src/server/audit/lighthousePayload.test.ts (from src/server/lib/lighthousePayload.test.ts, src/server/lib/lighthouseStoredPayload.test.ts, src/server/lib/dataforseoLighthousePayload.test.ts)
- src/server/audit/lighthousePhase.test.ts (from src/server/workflows/siteAuditWorkflowPhases.test.ts)
- src/components/portal/audit/lighthouse/LighthouseIssuesScreen.tsx (from src/client/features/lighthouse/issues/LighthouseIssuesScreen.tsx)
- src/components/portal/audit/lighthouse/LighthouseIssuesParts.tsx (from src/client/features/lighthouse/issues/LighthouseIssuesParts.tsx)
- src/components/portal/audit/lighthouse/LighthouseIssueRow.tsx (from src/client/features/lighthouse/issues/LighthouseIssueRow.tsx)
- src/components/portal/audit/lighthouse/LighthouseIssuesSummary.tsx (from src/client/features/lighthouse/issues/LighthouseIssuesSummary.tsx)
- src/components/portal/audit/lighthouse/types.ts (from src/client/features/lighthouse/issues/types.ts)
- src/components/portal/audit/lighthouse/utils.ts (from src/client/features/lighthouse/issues/utils.tsx)
- src/app/portal/audit/[auditId]/lighthouse/[resultId]/page.tsx (from src/routes/_app/p/$projectId/audit/issues/$resultId.tsx)

### F15 Phase 2 ports
- `src/shared/rank-tracking/service.ts` (from `openseo:src/server/features/rank-tracking/services/RankTrackingService.ts`)
- `src/shared/rank-tracking/runGuards.ts` (from `openseo:src/server/features/rank-tracking/services/rankCheckRunGuards.ts`)
- `src/shared/rank-tracking/checkPaths.ts` (from `openseo:src/server/workflows/rankCheckPaths.ts`)
- `src/shared/rank-tracking/retries.ts` (from `openseo:src/server/workflows/rankCheckRetries.ts`)
- `src/shared/rank-tracking/checkJob.ts` (from `openseo:src/server/workflows/RankCheckWorkflow.ts`)
- `src/shared/rank-tracking/results.ts` (from `openseo:src/server/features/rank-tracking/services/rankTrackingResults.ts`)
- `src/shared/pricing/actions/rankTracking.ts` (from `openseo:src/shared/rank-tracking.ts`)
- `src/shared/rank-tracking/jobs.ts` (from `openseo:src/server/features/rank-tracking/jobs`)
- `src/shared/rank-tracking/service.test.ts` (from `openseo:src/server/features/rank-tracking/services/RankTrackingService.test.ts`)
- `src/shared/rank-tracking/rankTracking.contract.ts` (from `openseo:src/types/schemas/rank-tracking.ts`)

### F25 Phase 3 ports
- `src/components/portal/email/EmailSettings.tsx` (from `src/client/features/settings/PrivacySettings.tsx`)
- `src/components/portal/email/ProductUpdatesSwitch.tsx` (from `src/client/features/settings/PrivacySettings.tsx`, `src/client/features/onboarding/AnalyticsOnboardingStep.tsx`)

### F16 Phase 4 ports
- `src/server/backlinks/ahrefsDomainRating.ts` (from `src/serverFunctions/ahrefs.ts`)
- `src/app/api/customer/backlinks/ahrefs-dr/route.ts` (from `src/serverFunctions/ahrefs.ts`)

### F18 Phase 6 ports
- src/server/audit/renderedPage.ts (from src/server/lib/audit/rendered-page.ts)
- src/server/audit/renderedPage.test.ts (from src/server/lib/audit/rendered-page.test.ts)
- src/server/audit/renderSettle.ts (from src/server/lib/audit/rendering-billing.ts)

### F12 Phase 2 ports
- `src/shared/question-history.ts` (from `openseo:src/client/features/ai-visibility/PromptDateRange.tsx`, `openseo:src/client/features/ai-visibility/shared.tsx`)
- `src/server/questions/history/summary.ts` (from `openseo:src/shared/ai-visibility-results.ts`)
- `src/server/questions/history/history.ts` (from `openseo:src/server/features/ai-visibility/services/aiVisibilityResults.ts`)
- `src/server/questions/history/answer.ts` (from `openseo:src/server/features/ai-visibility/services/aiVisibilityResults.ts`)

### F15 Phase 4 ports
- `src/components/portal/rank-tracking/CostEstimateBox.tsx` (from `openseo:src/client/features/rank-tracking/RankTrackingConfigModal.tsx:378-412`)
- `src/components/portal/rank-tracking/DomainListFilters.tsx` (from `openseo:src/client/features/rank-tracking/RankTrackingFilters.tsx`)
- `src/components/portal/rank-tracking/FirstCheckStep.tsx` (from `openseo:src/client/features/rank-tracking/RankTrackingConfigModal.tsx (first-check step)`)
- `src/components/portal/rank-tracking/hooks/useRankTrackers.ts` (from `openseo:src/client/features/rank-tracking/RankTrackingDomainList.tsx`)
- `src/components/portal/rank-tracking/hooks/useSaveConfigMutations.ts` (from `openseo:src/client/features/rank-tracking/useSaveConfigMutations.ts`)
- `src/components/portal/rank-tracking/KeywordSuggestionStep.tsx` (from `openseo:src/client/features/rank-tracking/KeywordSuggestionStep.tsx:144-342`)
- `src/components/portal/rank-tracking/RankTrackingConfigDialog.tsx` (from `openseo:src/client/features/rank-tracking/RankTrackingConfigModal.tsx:86-412`)
- `src/components/portal/rank-tracking/RankTrackingDomainList.tsx` (from `openseo:src/client/features/rank-tracking/RankTrackingDomainList.tsx:55-328`)
- `src/components/portal/rank-tracking/RankTrackingPage.tsx` (from `openseo:src/client/features/rank-tracking/RankTrackingDomainList.tsx:55-328`)
- `src/components/portal/rank-tracking/SearchTargetingField.tsx` (from `openseo:src/client/features/rank-tracking/SearchTargetingField.tsx`)
- `src/components/portal/rank-tracking/telemetry.ts` (from `openseo:src/client/lib/posthog.ts (rank-tracking event names)`)
- `src/shared/rank-tracking/suggestions.ts` (from `src/server/features/domain/services/DomainService.ts:122-216`)
- `src/shared/rank-tracking/metrics.ts` (from `src/server/features/rank-tracking/services/RankTrackingService.ts:328-380`)

### F20 Phase 5 ports
- `src/components/portal/analytics/OrganicOverviewCard.tsx` (from `openseo:src/client/features/dashboard/Ga4Card.tsx:43-180`)

### F11 Phase 2 ports
- `src/shared/explore.ts` (from `openseo:src/types/schemas/ai-search.ts:156-243`, `openseo:src/shared/prompt-explorer-labels.ts`)
- `src/server/explore/shape.ts` (from `openseo:src/server/features/ai-search/services/promptExplorer.ts:198-359`)
- `src/server/explore/routes.ts` (from `openseo:src/server/features/ai-search/services/promptExplorer.ts:104-182`)
- `src/server/explore/job.ts` (from `openseo:src/server/features/ai-search/services/promptExplorer.ts:53-94`)
- `src/server/explore/service.ts` (from `openseo:src/server/features/ai-search/services/promptExplorer.ts:104-182`)
- `src/app/api/customer/explore/route.ts` (from `openseo:src/serverFunctions/ai-search.ts:19-24`)

### F12 Phase 3 ports
- `src/app/portal/questions/[questionId]/page.tsx` (from `openseo:src/routes/_app/p/$projectId/ai-visibility/prompts/$promptId.tsx`)
- `src/components/app/markdown/MarkdownAnswer.tsx` (from `openseo:src/client/features/ai-visibility/MarkdownAnswer.tsx`)
- `src/components/portal/questions/history/QuestionHistoryPage.tsx` (from `openseo:src/client/features/ai-visibility/PromptHistoryPage.tsx`, `PromptAnalysis.tsx`)
- `src/components/portal/questions/history/AnswerPanel.tsx` (from `openseo:src/client/features/ai-visibility/PromptHistoryPage.tsx`)
- `src/components/portal/questions/history/AnswerEvidence.tsx` (from `openseo:src/client/features/ai-visibility/AnswerContent.tsx`)
- `src/components/portal/questions/history/BrandComparison.tsx` (from `openseo:src/client/features/ai-visibility/PromptSummary.tsx`)
- `src/components/portal/questions/history/Executions.tsx` (from `openseo:src/client/features/ai-visibility/PromptExecutions.tsx`)
- `src/components/portal/questions/history/HistoryDateRange.tsx` (from `openseo:src/client/features/ai-visibility/PromptDateRange.tsx`)
- `src/components/portal/questions/history/MentionBadge.tsx` (from `openseo:src/client/features/ai-visibility/PromptExecutions.tsx`)
- `src/components/portal/questions/history/hooks/useQuestionHistory.ts` (from `openseo:src/client/features/ai-visibility/usePromptHistory.ts`)

### F15 Phase 5 ports
- `src/shared/rank-tracking/runPolling.ts` (from `openseo:src/client/features/rank-tracking/useRankRunPolling.ts:9-47`)
- `src/components/portal/rank-tracking/AddKeywordsPanel.tsx` (from `openseo:src/client/features/rank-tracking/AddKeywordsModal.tsx`)
- `src/components/portal/rank-tracking/AiOverviewStrip.tsx` (from `openseo:src/client/features/rank-tracking/RankTrackingDomainDetail.tsx`)
- `src/components/portal/rank-tracking/KeywordTrendModal.tsx` (from `openseo:src/client/features/rank-tracking/KeywordTrendModal.tsx`)
- `src/components/portal/rank-tracking/RankRunAlerts.tsx` (from `openseo:src/client/features/rank-tracking/RankRunAlerts.tsx`)
- `src/components/portal/rank-tracking/RankTrackingColumns.tsx` (from `openseo:src/client/features/rank-tracking/RankTrackingColumns.tsx`)
- `src/components/portal/rank-tracking/RankTrackingDetailHeader.tsx` (from `openseo:src/client/features/rank-tracking/RankTrackingDomainDetail.tsx`)
- `src/components/portal/rank-tracking/RankTrackingDomainDetail.tsx` (from `openseo:src/client/features/rank-tracking/RankTrackingDomainDetail.tsx`)
- `src/components/portal/rank-tracking/RankTrackingFilterPanel.tsx` (from `openseo:src/client/features/rank-tracking/RankTrackingFilters.tsx`)
- `src/components/portal/rank-tracking/RankTrackingHistoryMatrix.tsx` (from `openseo:src/client/features/rank-tracking/RankTrackingHistoryMatrix.tsx`)
- `src/components/portal/rank-tracking/RankTrackingOverview.tsx` (from `openseo:src/client/features/rank-tracking/RankTrackingOverview.tsx`)
- `src/components/portal/rank-tracking/RankTrackingTable.tsx` (from `openseo:src/client/features/rank-tracking/RankTrackingTable.tsx`)
- `src/components/portal/rank-tracking/RankTrackingTableParts.tsx` (from `openseo:src/client/features/rank-tracking/RankTrackingTableParts.tsx`)
- `src/components/portal/rank-tracking/RankTrackingTableToolbar.tsx` (from `openseo:src/client/features/rank-tracking/RankTrackingTableToolbar.tsx`)
- `src/components/portal/rank-tracking/RankTrendChart.tsx` (from `openseo:src/client/features/rank-tracking/RankTrendChart.tsx`)
- `src/components/portal/rank-tracking/ToolbarMenus.tsx` (from `openseo:src/client/features/rank-tracking/ToolbarMenus.tsx`)
- `src/components/portal/rank-tracking/hooks/useMetricsRefresh.ts` (from `openseo:src/client/features/rank-tracking/useMetricsRefresh.ts`)
- `src/components/portal/rank-tracking/hooks/useRankCheckTrigger.ts` (from `openseo:src/client/features/rank-tracking/useRankCheckTrigger.ts`)
- `src/components/portal/rank-tracking/hooks/useRankResults.ts` (from `openseo:src/client/features/rank-tracking/RankTrackingDomainDetail.tsx`)
- `src/components/portal/rank-tracking/hooks/useRankRunPolling.ts` (from `openseo:src/client/features/rank-tracking/useRankRunPolling.ts`)
- `src/components/portal/rank-tracking/hooks/useSetKeywordPinned.ts` (from `openseo:src/client/features/rank-tracking/useSetKeywordPinned.ts`)

### F15 Phase 6 ports
- `src/shared/rank-tracking/tools.ts` (from `openseo:src/server/mcp/tools/`)
- `src/components/portal/rank-tracking/AiVisibilityCell.tsx` (from `openseo:src/client/features/rank-tracking/`)
- `src/components/portal/rank-tracking/TrackAiQuestionDialog.tsx` (from `openseo:src/client/features/rank-tracking/`)

### F20 Phase 6 ports
- `src/server/ga4/tools.ts` (from `openseo:src/server/mcp/tools/google-analytics-tools.ts`)

### F27 Phase 1 ports
- `src/shared/onboarding.ts` (from `openseo:src/client/features/onboarding/onboardingModel.ts:4-19`)
- `src/shared/setup-steps.ts` (from `openseo:src/client/features/dashboard/dashboardSteps.ts:1-79`)
- `src/server/onboarding/website.ts` (from `openseo:src/serverFunctions/projects.ts:67-81`, `openseo:src/server/features/dashboard/services/DashboardFirstAuditService.ts:11-90`)
- `src/server/onboarding/steps.ts` (from `openseo:src/serverFunctions/onboarding.ts:77-136`)
- `src/server/onboarding/setup.ts` (from `openseo:src/server/features/dashboard/services/DashboardService.ts:52-98`, `openseo:src/serverFunctions/dashboard.ts:55-66`)

### F11 Phase 3 ports
- `src/components/portal/explore/ExplorePage.tsx` (from `openseo:src/client/features/ai-search/PromptExplorerPage.tsx`)
- `src/components/portal/explore/ExploreForm.tsx` (from `openseo:src/client/features/ai-search/components/PromptExplorerForm.tsx`)
- `src/components/portal/explore/ExploreResults.tsx` (from `openseo:src/client/features/ai-search/components/PromptExplorerResults.tsx`)
- `src/components/portal/explore/ExploreLoadingState.tsx` (from `openseo:src/client/features/ai-search/components/PromptExplorerLoadingState.tsx`)
- `src/components/portal/explore/RecentQuestions.tsx` (from `openseo:src/client/features/ai-search/PromptExplorerPage.tsx`)
- `src/components/portal/explore/TrackQuestionButton.tsx` (from `openseo:src/client/features/ai-search/PromptExplorerPage.tsx`)
- `src/components/portal/explore/engineAccents.ts` (from `openseo:src/client/features/ai-search/platformLabels.ts:13-35`)
- `src/components/portal/explore/hooks/useExplore.ts` (from `openseo:src/client/features/ai-search/promptExplorerQuery.ts`)
- `src/app/portal/explore/page.tsx` (from `openseo:src/routes/_app/p/$projectId/prompt-explorer.tsx`)

### F27 Phase 2 ports
- `src/components/portal/onboarding/OnboardingShell.tsx` (from `src/client/features/onboarding/PostSignupOnboarding.tsx:22-69`, `src/client/features/onboarding/OnboardingCard.tsx:8-51`)
- `src/components/portal/onboarding/WizardFooter.tsx` (from `src/client/features/onboarding/WizardFooter.tsx`)
- `src/components/portal/onboarding/SearchConsoleStep.tsx` (from `src/client/features/onboarding/SearchConsoleOnboardingStep.tsx`)
- `src/components/portal/onboarding/PreferencesStep.tsx` (from `src/client/features/onboarding/AnalyticsOnboardingStep.tsx`)
- `src/app/onboarding/page.jsx` (from `src/routes/_authenticated.onboarding.index.tsx:18-151`)
- `src/components/portal/onboarding/OnboardingWizard.tsx` (from `src/routes/_authenticated.onboarding.index.tsx:18-151`)
- `src/components/portal/onboarding/WebsiteStep.tsx` (from `src/client/features/onboarding/WebsiteOnboardingStep.tsx:28-211`)
- `src/components/app/onboarding/useOnboardingRedirect.ts` (from `src/client/features/onboarding/useOnboardingRedirect.ts:12-61`, `src/routes/_app/route.tsx:34-39`)
- `src/components/portal/PortalShell.jsx` (from `src/client/features/onboarding/useOnboardingRedirect.ts:12-61`, `src/routes/_app/route.tsx:34-39`)

### F22 Phase 1 ports
- `src/server/tools/links.ts` (from `src/server/mcp/urls.ts`)
- `src/server/tools/capOutput.ts` (from `src/server/features/sam/samToolOutput.ts`)
- `src/server/tools/capOutput.test.ts` (three parity cases from `src/server/features/sam/samToolOutput.test.ts`)
- `src/server/tools/errors.ts` (from `src/server/mcp/tool-error-message.ts`, `src/server/mcp/instrumentation.ts`)
- `src/server/tools/run.ts` (from `src/server/features/sam/samChatTools.ts`)
- `src/server/tools/waiting.ts` and `src/server/tools/waiting.test.ts` (from `src/server/features/sam/samChatTools.ts`)
- `src/server/tools/format.ts` (from `src/server/mcp/formatters.ts`)
- `src/server/tools/mcp.ts` (from `src/server/mcp/output-schemas.ts`, `src/server/mcp/server.ts`)

### F27 Phase 3 ports
- `src/components/portal/overview/SetupChecklist.tsx` (from `openseo:src/client/features/dashboard/DashboardOnboarding.tsx:24-180`)

### F22 Phase 2 ports
- `src/server/assistant/sessions.ts` (from `src/server/features/sam/SamSessionRepository.ts`, the title rule in `src/server/features/sam/SamChatAgent.ts` and the session schema in `src/db/pg/sam.schema.ts`)
- `supabase/migrations/145_f22_assistant_sessions.sql` (session/message schema from `src/db/pg/sam.schema.ts`; rewind rule from `src/server/features/sam/SamChatAgent.ts`)

### F04 Phase 6 ports
- `src/components/portal/AuthLayout.jsx` (from `src/client/features/auth/AuthPage.tsx:131-175`)

### F22 Phase 3 ports
- `src/server/tools/own/siteReading.ts` (from `src/server/lib/scrape.ts`, `src/server/features/sam/samChatTools.ts`)

### F22 Phase 4 ports
- `src/server/assistant/aiTools.ts` (from `src/server/features/sam/samChatTools.ts`)
- `src/server/assistant/compaction.ts` (from `src/server/features/sam/SamChatAgent.ts`)
- `src/server/assistant/jobs.ts` (from `src/server/features/sam/SamChatAgent.ts`)
- `src/server/assistant/prompt.ts` (from `src/server/features/sam/samSystemPrompt.ts`)
- `src/server/assistant/turn.ts` (from `src/server/features/sam/SamChatAgent.ts`)

### F23 Phase 1 ports
- `src/shared/reports.ts` (from `src/types/schemas/reports.ts:5-70`, `src/types/schemas/report-templates.ts:5-26`)
- `src/shared/report-share.ts` (from `src/shared/report-share.ts:5-20`, `src/server/features/reports/shareAccess.ts:23`, `src/routes/s/$token/raw.ts:44-53`)
- `src/shared/report-sandbox.ts` (from `src/shared/report-sandbox.ts:1-130`)
- `src/shared/report-sandbox.test.ts` (from `src/shared/report-sandbox.test.ts:4-17`)
- `src/server/reports/repository.ts` (from `src/server/features/reports/repositories/ReportRepository.ts:1-276`)
- `src/server/reports/service.ts` (from `src/server/features/reports/services/ReportService.ts:22-326`)
- `src/server/reports/service.test.ts` (ported cases from `src/server/features/reports/services/ReportService.test.ts:61-276`)
- `src/server/reports/templateRepository.ts` (from `src/server/features/reports/repositories/ReportTemplateRepository.ts:1-113`)
- `src/server/reports/templateService.ts` (from `src/server/features/reports/services/ReportTemplateService.ts:17-184`)
- `src/server/reports/templateService.test.ts` (ported cases from `src/server/features/reports/services/ReportTemplateService.test.ts:53-115`)
- `supabase/migrations/150_f23_reports.sql` (from `src/db/reports.schema.ts:11-85`, `src/db/report-templates.schema.ts:5-43`)
- `supabase/migrations/151_f23_report_share_views.sql` (from `src/routes/s/$token/raw.ts:44-53`, `src/db/reports.schema.ts`)

### F23 Phase 2 ports
- `src/server/reports/documentRoutes.ts` (from `src/routes/r/$reportId.ts`, `src/routes/s/$token/raw.ts`, `src/routes/s/$token/og[.]png.ts`, `src/server/features/reports/shareAccess.ts`)
- `src/server/reports/documentRoutes.test.ts` (ported cases from `src/server/features/reports/reportRoute.test.ts`, `src/server/features/reports/shareRawRoute.test.ts`)
- `src/server/reports/sharePage.ts` (from `src/server/features/reports/sharePage.tsx:12-260`)
- `src/server/reports/sharePage.test.ts` (ported cases from `src/server/features/reports/sharePage.test.ts:36-124`)
- `src/server/reports/ogImage.tsx` (from `src/server/features/reports/reportSocialImage.tsx:6-89`)
- `src/server/reports/ogRoute.test.ts` (ported cases from `src/server/features/reports/shareImageRoute.test.ts:33-99`)

### F22 Phase 5 ports
- `src/components/portal/assistant/AssistantPage.tsx` (from `src/client/features/sam/SamChat.tsx`)
- `src/components/portal/assistant/SessionList.tsx` (from `src/client/features/sam/SamSidebarPanel.tsx`)
- `src/components/portal/assistant/Conversation.tsx` (from `src/client/features/sam/SamConversation.tsx`)
- `src/components/portal/assistant/ChatMessage.tsx` (from `src/client/components/chat/ChatMessage.tsx`)
- `src/components/portal/assistant/assistantMarkdown.tsx` (from `src/client/components/Markdown.tsx`)
- `src/components/portal/assistant/hooks/useAssistantSessions.ts` (from `src/client/features/sam/useSamSessions.ts`)
- `src/components/portal/assistant/hooks/useAssistantChat.ts` (from `src/client/features/sam/useSamSessions.ts`, `src/client/features/sam/SamConversation.tsx`)
- `src/components/portal/assistant/ChatComposer.tsx` (copied from `src/client/features/sam/ChatComposer.tsx`)
- `src/components/portal/assistant/useStickToBottom.ts` (copied from `src/client/components/chat/useStickToBottom.ts`)
- `src/shared/assistant-tools.ts` (copied from `src/client/components/chat/ChatMessage.tsx:25-28`, `humanizeToolName`)

### F22 Phase 6 ports
- `src/server/tools/contract.test.ts` (contract cases from `src/server/mcp/output-schema-contract.test.ts`)
- `src/server/tools/waiting.test.ts` (waiting cases from `src/server/features/sam/samChatTools.test.ts`)
- `src/components/portal/assistant/hooks/useAssistantSessions.ts` (query keys from `src/client/features/sam/samQueries.ts`)
- `src/app/api/customer/assistant/{sessions,config}/route.ts` (from `src/serverFunctions/sam.ts`, `src/serverFunctions/samAccess.ts`)

### F23 Phase 4 ports
- `src/components/portal/reports/ReportsList.tsx` (from `src/client/features/reports/ReportsList.tsx:20-99`)
- `src/components/portal/reports/ReportViewer.tsx` (from `src/client/features/reports/ReportViewer.tsx:21-56`)
- `src/components/portal/reports/ShareReportDialog.tsx` (from `src/client/features/reports/shared.tsx:110-253`)
- `src/components/portal/reports/DeleteReportDialog.tsx` (from `src/client/features/reports/shared.tsx:84-108`)
- `src/components/portal/reports/FullScreenReport.tsx` (from `src/routes/_app/p/$projectId/reports/$reportId.tsx:300-346`)
- `src/components/portal/reports/ReportTemplatesList.tsx` (from `src/client/features/reports/ReportTemplatesList.tsx:17-86`)
- `src/components/portal/reports/ReportTemplateForm.tsx` (from `src/client/features/reports/ReportTemplateForm.tsx:18-150`)
- `src/components/portal/reports/hooks/useReports.ts` (from `src/client/features/reports/shared.tsx:36-53`)
- `src/components/portal/reports/formatWrittenBy.ts` (pattern from `src/client/features/reports/shared.tsx:45-54`)
- `src/app/portal/reports/page.tsx` (from `src/routes/_app/p/$projectId/reports/index.tsx:20-82`)
- `src/app/portal/reports/[reportId]/page.tsx` (from `src/routes/_app/p/$projectId/reports/$reportId.tsx:44-346`)
- `src/app/portal/reports/templates/page.tsx` (from `src/routes/_app/p/$projectId/reports/templates.tsx:27-125`)

### F23 Phase 2-3 route ports
- `src/app/r/[reportId]/route.ts` (from `openseo:src/routes/r/$reportId.ts:10-105`)
- `src/app/s/[token]/route.ts` (from `openseo:src/server/features/reports/sharePage.tsx:12-260`)
- `src/app/s/[token]/raw/route.ts` (from `openseo:src/routes/s/$token/raw.ts:12-132`)
- `src/app/s/[token]/og.png/route.tsx` (from `openseo:src/routes/s/$token/og[.]png.ts:9-46`)
- `src/app/api/customer/reports/route.ts` (from `openseo:src/serverFunctions/reports.ts:20-136`)
- `src/app/api/customer/reports/[reportId]/route.ts` (from `openseo:src/serverFunctions/reports.ts:20-136`)
- `src/app/api/customer/reports/[reportId]/share/route.ts` (from `openseo:src/serverFunctions/reports.ts:20-136`)
- `src/app/api/customer/reports/templates/route.ts` (from `openseo:src/serverFunctions/reportTemplates.ts:7-69`)
- `src/app/api/customer/reports/templates/[templateId]/route.ts` (from `openseo:src/serverFunctions/reportTemplates.ts:7-69`)
- `src/app/api/customer/reports/generate/route.ts` (new endpoint; route shape follows `openseo:src/serverFunctions/reports.ts:20-136`)
## Component libraries vendored through the shadcn registry (MIT)

Source files from the projects below are copied into this repository with
`npx shadcn add` (registries are listed in `components.json`) and modified for
Perceev. Each project is published under the MIT license; the full license
text and copyright notice are in the upstream repository named for each.

| Library | Vendored into | Upstream |
| --- | --- | --- |
| Bklit UI (charts) | `src/components/charts/`, `src/components/shimmering-text.tsx` | https://ui.bklit.com · registry `@bklit` |
| Motion Primitives | `src/components/motion-primitives/` | https://github.com/ibelick/motion-primitives · registry `@motion-primitives` |
| Kokonut UI | `src/components/kokonutui/` | https://github.com/kokonut-labs/kokonutui · registry `@kokonutui` |
| Watermelon UI | `src/components/watermelon/` | https://github.com/WatermelonCorp/watermelon-platform · registry `@watermelon` |
| Magic UI (animated beam, marquee) | `src/components/magicui/` | https://github.com/magicuidesign/magicui · registry `@magicui` |
| Aceternity UI (glowing effect; free component) | `src/components/aceternity/` | https://ui.aceternity.com · registry `@aceternity` |

`src/components/charts/patterns/` additionally carries code derived from visx;
its license is kept beside it as `LICENSE-visx-pattern`.

npm packages added for these: `motion` (replaces `framer-motion`), `animejs`,
`d3-array`, `d3-scale`, `d3-shape`, `@number-flow/react`, `react-use-measure`.
Each is used under its own license as published on npm.

## React Bits (MIT + Commons Clause License Condition v1.0)

`src/components/reactbits/Threads.tsx` and `src/components/reactbits/Magnet.tsx`
are copied from React Bits (https://github.com/DavidHDev/react-bits, registry
`@react-bits`), Copyright (c) 2026 David Haz. They are used as part of this
website under the upstream license, whose Commons Clause permits commercial use
in an application, website or product but forbids selling, sublicensing or
redistributing the components themselves, alone or bundled. The full license
text is in the upstream repository's `LICENSE.md`.

npm packages added for the landing page (branch `landing-page-2`): `gsap`
(ScrollTrigger, SplitText, Flip), `three`, `@react-three/fiber`. Each is used
under its own license as published on npm.
