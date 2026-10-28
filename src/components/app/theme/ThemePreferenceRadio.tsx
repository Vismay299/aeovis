"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/ThemePreferenceMenuItems.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { ReactNode } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { SegmentedToggle } from "@/components/app/SegmentedToggle";
import {
  DropdownMenuLabel,
  DropdownMenuGroup,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import { useThemePreference } from "@/components/app/theme/useThemePreference";
import type { ThemePreference } from "@/lib/theme/theme";

const THEME_OPTIONS: {
  value: ThemePreference;
  label: string;
  icon: ReactNode;
}[] = [
  { value: "system", label: "System", icon: <Monitor /> },
  { value: "light", label: "Light", icon: <Sun /> },
  { value: "dark", label: "Dark", icon: <Moon /> },
];

/** System / Light / Dark segmented radio, shared by Settings and account menus. */
export function ThemePreferenceRadio() {
  const { themePreference, setThemePreference } = useThemePreference();

  return (
    <SegmentedToggle
      items={THEME_OPTIONS}
      value={themePreference}
      onChange={setThemePreference}
    />
  );
}

export function ThemePreferenceDropdownItems() {
  const { themePreference, setThemePreference } = useThemePreference();

  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel>Theme</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={themePreference}
        onValueChange={(value) => {
          const option = THEME_OPTIONS.find((item) => item.value === value);
          if (option) setThemePreference(option.value);
        }}
      >
        {THEME_OPTIONS.map(({ value, label, icon }) => (
          <DropdownMenuRadioItem key={value} value={value}>
            {icon} {label}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenuGroup>
  );
}
