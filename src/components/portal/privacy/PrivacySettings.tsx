"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/settings/PrivacySettings.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useState } from "react";
import { toast } from "sonner";
import { CardShell } from "@/components/app/CardShell";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/app/QueryState";
import { AnalyticsConsentSwitch } from "@/components/app/telemetry/AnalyticsConsentSwitch";
import { useAnalyticsConsent } from "@/components/app/telemetry/useAnalyticsConsent";
import { hasGlobalPrivacyControl } from "@/shared/privacy-choices";
import { formatDate } from "@/components/portal/ui";

export function PrivacySettings() {
  const { choice, available, decidedAt, save, loading, isError, error, refetch } =
    useAnalyticsConsent();
  const [saving, setSaving] = useState(false);

  const gpc = hasGlobalPrivacyControl();

  if (loading) {
    return (
      <CardShell title="Usage analytics">
        <Skeleton className="h-6 w-full max-w-sm" />
      </CardShell>
    );
  }

  if (isError) {
    return (
      <QueryError
        error={error}
        fallback="Privacy settings could not be loaded."
        onRetry={() => void refetch()}
      />
    );
  }

  const currentValue = choice === true;

  async function handleToggle(next: boolean) {
    setSaving(true);
    try {
      await save(next, "settings");
    } catch {
      toast.error("Your privacy settings couldn't be saved. Please retry.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <CardShell title="Usage analytics">
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            This setting applies to your account in every workspace.
          </p>

          <AnalyticsConsentSwitch
            source="settings"
            value={currentValue}
            onChange={handleToggle}
            disabled={saving || !available}
          />

          {decidedAt ? (
            <p className="text-sm text-muted-foreground">
              You chose this on {formatDate(decidedAt)}.
            </p>
          ) : null}

          {!available ? (
            <p className="text-sm text-muted-foreground">
              Usage analytics isn't collected on this deployment.
            </p>
          ) : null}

          {gpc ? (
            <p className="text-sm text-muted-foreground">
              Your browser asks sites not to track you, so analytics stays off
              unless you turn it on here.
            </p>
          ) : null}
        </div>
      </CardShell>
    </div>
  );
}
