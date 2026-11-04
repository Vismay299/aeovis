"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/LocationSelect.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import {
  CountryCombobox,
  type LocationOption,
} from "@/components/app/CountryCombobox";

export type { LocationOption };

type Props = {
  value: number;
  onChange: (locationCode: number) => void;
  /** Required list of locations. */
  options: readonly LocationOption[];
  /** Width utilities for the field. Defaults to full width. */
  className?: string;
};

/**
 * Searchable country picker for search cards: `CountryCombobox` with its own
 * label and placeholder, so both pickers filter the same way.
 */
export function LocationSelect({
  value,
  onChange,
  options,
  className = "w-full",
}: Props) {
  return (
    <CountryCombobox
      value={value}
      onChange={onChange}
      options={options}
      className={className}
      placeholder="Select country"
      aria-label="Country"
    />
  );
}
