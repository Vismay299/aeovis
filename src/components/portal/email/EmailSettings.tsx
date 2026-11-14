"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/settings/PrivacySettings.tsx:12-62
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useId } from "react";
import { toast } from "sonner";
import { CardShell } from "@/components/app/CardShell";
import { NotFound } from "@/components/app/NotFound";
import { QueryState } from "@/components/app/QueryState";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { usePortal } from "@/components/portal/PortalShell";
import { ProductUpdatesSwitch } from "./ProductUpdatesSwitch";
import {
  useEmailPreferences,
  type EmailPreferenceField,
  type EmailPreferencesSource,
} from "./hooks/useEmailPreferences";

const NOTIFICATION_ROWS: Array<{
  field: EmailPreferenceField;
  title: string;
  description: string;
}> = [
  {
    field: "scanResults",
    title: "Scan results",
    description: "An email when a scan finishes, with the headline numbers.",
  },
  {
    field: "scheduleAlerts",
    title: "Skipped scheduled scans",
    description:
      "Sent to workspace owners when a scheduled scan doesn't run, with the reason.",
  },
  {
    field: "spendAlerts",
    title: "Spend limits",
    description:
      "Sent to workspace owners when a workspace reaches its daily or monthly spend limit.",
  },
];

function EmailNotificationRow({
  labelId,
  title,
  description,
  checked,
  disabled,
  onChange,
}: {
  labelId: string;
  title: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div>
        <p id={labelId} className="text-sm font-medium">
          {title}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        aria-labelledby={labelId}
      />
    </div>
  );
}

export function EmailSettings() {
  const { features } = usePortal();
  const { save, saving, query } = useEmailPreferences();
  const labelBaseId = useId();

  if (features !== null && features.lifecycle_email !== true) {
    return <NotFound />;
  }

  const loadingView = (
    <CardShell title="Email notifications">
      <div className="space-y-3 py-1">
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-full" />
      </div>
    </CardShell>
  );

  if (features === null) {
    return <div className="space-y-6">{loadingView}</div>;
  }

  async function handleSave(
    field: EmailPreferenceField,
    next: boolean,
    source: EmailPreferencesSource = "settings",
  ) {
    try {
      await save(field, next, source);
    } catch {
      toast.error("We couldn't save your email choice.");
    }
  }

  return (
    <div className="space-y-6">
      <QueryState
        query={query}
        errorFallback="Email settings could not be loaded."
        loading={loadingView}
      >
        {(prefs) => (
          <>
            <CardShell title="Email notifications">
              <p className="mb-4 text-sm text-muted-foreground">
                These settings apply to your account in every workspace.
              </p>
              <div className="space-y-4">
                {NOTIFICATION_ROWS.map((row) => (
                  <EmailNotificationRow
                    key={row.field}
                    labelId={`${labelBaseId}-${row.field}`}
                    title={row.title}
                    description={row.description}
                    checked={prefs[row.field]}
                    disabled={saving}
                    onChange={(next) => void handleSave(row.field, next)}
                  />
                ))}
              </div>
            </CardShell>
            <CardShell title="Product updates">
              <ProductUpdatesSwitch
                source="settings"
                value={prefs.productUpdates}
                onChange={(next, source) =>
                  void handleSave("productUpdates", next, source)
                }
                disabled={saving}
              />
              {prefs.loopsConfigured === false ? (
                <p className="mt-3 text-sm text-muted-foreground">
                  Product update emails aren&apos;t set up yet. Your choice is
                  saved.
                </p>
              ) : null}
            </CardShell>
          </>
        )}
      </QueryState>
    </div>
  );
}
