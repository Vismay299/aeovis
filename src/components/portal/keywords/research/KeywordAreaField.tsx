// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/keywords/page/KeywordAreaField.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useState } from "react";
import { formatUsd } from "@/shared/pricing";
import { getIsoCountryCode } from "@/shared/keyword-locations";
import { SerpLocationCombobox } from "./SerpLocationCombobox";
import { usePrewarmSerpLocations } from "./usePrewarmSerpLocations";

/**
 * Optional city, county, or region inside the selected country. Empty means
 * national volume. The location list is warmed on first focus, so page views
 * that never use the field cost nothing.
 */
export function KeywordAreaField({ brandKey, locationCode, value, onChange }: {
  brandKey: string;
  locationCode: number;
  value: string | undefined;
  onChange: (locationName: string | undefined) => void;
}) {
  const [focused, setFocused] = useState(false);
  const countryCode = getIsoCountryCode(locationCode);
  usePrewarmSerpLocations(brandKey, countryCode, focused);

  return (
    <div
      className="w-full"
      onFocus={() => setFocused(true)}
      title="Get search volume for one city, county, or region. Leave empty for the whole country."
    >
      <SerpLocationCombobox
        id="keyword-area"
        aria-label="City (optional)"
        brandKey={brandKey}
        value={value}
        onChange={onChange}
        countryCode={countryCode}
        placeholder="City (optional)"
      />
    </div>
  );
}

/** The extra Google Ads lookup a local search makes, from the live quote. */
export function LocalVolumeCostNote({ usd }: { usd: number }) {
  return (
    <p className="text-xs text-muted-foreground">
      Local volume adds up to {formatUsd(usd)} per search.
    </p>
  );
}
