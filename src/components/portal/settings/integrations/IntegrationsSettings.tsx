"use client";

import { usePortal } from "@/components/portal/PortalShell";
import { Ga4ConnectionCard } from "./Ga4ConnectionCard";
import { GoogleAccountsCard } from "./GoogleAccountsCard";
import { SearchConsoleNote } from "./SearchConsoleNote";

/** Settings → Integrations (F20 §6.6.2). */
export function IntegrationsSettings() {
  const { brandKey, features } = usePortal();
  if (!brandKey) return null;
  if (features && features.ga4 !== true) {
    return <p className="text-sm text-muted-foreground">This page is not available for your workspace yet.</p>;
  }
  return (
    <div className="space-y-8">
      <Ga4ConnectionCard brandKey={brandKey} returnTo="/portal/settings/integrations" />
      <GoogleAccountsCard brandKey={brandKey} />
      <SearchConsoleNote />
    </div>
  );
}
