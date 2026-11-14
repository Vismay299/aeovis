"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/settings/PrivacySettings.tsx:12-62
//   src/client/features/onboarding/AnalyticsOnboardingStep.tsx:33-56,95-107
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { Switch } from "@/components/ui/switch";
import type { EmailPreferencesSource } from "./hooks/useEmailPreferences";

export function ProductUpdatesSwitch({
  source,
  value,
  onChange,
  disabled = false,
}: {
  source: EmailPreferencesSource;
  value: boolean;
  onChange: (checked: boolean, source: EmailPreferencesSource) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div>
        <p className="text-sm font-medium">
          Product updates
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Occasional emails about new features and tips. Unsubscribe anytime.
        </p>
      </div>
      <Switch
        checked={value}
        onCheckedChange={(checked) => onChange(checked, source)}
        disabled={disabled}
        aria-label="Get product update emails"
      />
    </div>
  );
}
