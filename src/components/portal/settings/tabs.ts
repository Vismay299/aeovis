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
];
