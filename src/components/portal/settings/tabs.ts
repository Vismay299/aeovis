// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/projects/SettingsTabs.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

/**
 * The settings sections.
 *
 * A registry, so a later feature adds its own section (and its own tab) in
 * its own PR instead of editing the settings layout.
 */
export type SettingsTab = {
  href: string;
  label: string;
  /** Match only this path, not the paths below it. */
  exact?: boolean;
  /** A CLIENT_FEATURES name. The tab is hidden unless the flag is on. */
  flag?: string;
  /** Only an owner sees this tab. */
  ownerOnly?: boolean;
};

export const SETTINGS_TABS: SettingsTab[] = [
  { href: "/portal/settings", label: "General", exact: true },
  { href: "/portal/settings/privacy", label: "Privacy", flag: "product_analytics" },
];

