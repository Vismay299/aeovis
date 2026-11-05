"use client";

import type { ReactNode } from "react";
import { PageHeader } from "@/components/app/PageHeader";
import { NavTab, NavTabs } from "@/components/app/NavTabs";
import { SETTINGS_TABS } from "@/components/portal/settings/tabs";
import { usePortal } from "@/components/portal/PortalShell";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const { brand, isOwner, features } = usePortal();

  const tabs = SETTINGS_TABS.filter(
    (tab) =>
      (!tab.ownerOnly || isOwner) &&
      (!tab.flag || features?.[tab.flag] === true)
  );

  return (
    <div className="space-y-8">
      <PageHeader
        title="Workspace settings"
        description={`Settings for ${brand?.display_name ?? "this workspace"}.`}
      />
      <NavTabs label="Workspace settings sections">
        {tabs.map((tab) => (
          <NavTab key={tab.href} href={tab.href} exact={tab.exact}>
            {tab.label}
          </NavTab>
        ))}
      </NavTabs>
      {children}
    </div>
  );
}
