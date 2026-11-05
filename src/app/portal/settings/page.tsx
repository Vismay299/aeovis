"use client";

import { CardShell } from "@/components/app/CardShell";
import { PermissionHint } from "@/components/app/PermissionHint";
import { SafeExternalLink } from "@/components/app/SafeExternalLink";
import { ThemePreferenceRadio } from "@/components/app/theme/ThemePreferenceRadio";
import { usePortal } from "@/components/portal/PortalShell";

/** The host of the workspace's website, without the scheme or a trailing slash. */
function hostOf(website: string | undefined | null): string {
  if (!website) return "";
  return website.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export default function SettingsPage() {
  const { brand, isOwner } = usePortal();
  const website = brand?.website ?? "";

  return (
    <div className="space-y-6">
      <CardShell title="Workspace">
        <dl className="space-y-3 text-sm">
          <div className="flex items-center justify-between gap-4">
            <dt className="text-muted-foreground">Name</dt>
            <dd className="font-medium">{brand?.display_name ?? "—"}</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-muted-foreground">Website</dt>
            <dd>
              <SafeExternalLink
                url={website}
                label={hostOf(website) || "—"}
                className="font-medium text-primary underline-offset-4 hover:underline"
              />
            </dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-muted-foreground">Your role</dt>
            <dd className="font-medium">{isOwner ? "Owner" : "Member"}</dd>
          </div>
        </dl>
        <PermissionHint
          action="change the workspace name or website"
          className="mt-4"
        />
      </CardShell>

      <CardShell title="Appearance">
        <div className="space-y-2">
          <span className="text-sm font-medium">Theme</span>
          <div>
            <ThemePreferenceRadio showLabels />
          </div>
          <p className="text-sm text-muted-foreground">
            Applies to this browser. The public website is always light.
          </p>
        </div>
      </CardShell>
    </div>
  );
}
