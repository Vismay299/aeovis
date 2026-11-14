// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/rank-tracking/SearchTargetingField.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useId } from "react";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { SerpLocationCombobox } from "@/components/portal/keywords/research/SerpLocationCombobox";
import { usePrewarmSerpLocations } from "@/components/portal/keywords/research/usePrewarmSerpLocations";

export type TargetingMode = "national" | "local";

export function SearchTargetingField({
  brandKey,
  mode,
  onModeChange,
  locationName,
  onLocationNameChange,
  countryCode,
  error,
}: {
  brandKey: string;
  mode: TargetingMode;
  onModeChange: (mode: TargetingMode) => void;
  locationName: string | undefined;
  onLocationNameChange: (locationName: string | undefined) => void;
  countryCode: string;
  /** The error for the city, shown under the city search. */
  error?: string;
}) {
  const id = useId();
  // Warm the moment Local targeting is in play.
  usePrewarmSerpLocations(brandKey, countryCode, mode === "local");
  return (
    <FieldSet className="gap-2" data-invalid={error ? true : undefined}>
      <FieldLegend variant="label" className="mb-0">
        Search targeting
      </FieldLegend>
      <RadioGroup
        value={mode}
        onValueChange={(value) => {
          if (value === "local") onModeChange("local");
          if (value === "national") {
            onModeChange("national");
            onLocationNameChange(undefined);
          }
        }}
        className="flex gap-4"
      >
        <Field orientation="horizontal" className="w-auto">
          <RadioGroupItem value="national" id={`${id}-national`} />
          <FieldLabel htmlFor={`${id}-national`} className="font-normal">
            Country-wide
          </FieldLabel>
        </Field>
        <Field orientation="horizontal" className="w-auto">
          <RadioGroupItem value="local" id={`${id}-local`} />
          <FieldLabel htmlFor={`${id}-local`} className="font-normal">
            City or region
          </FieldLabel>
        </Field>
      </RadioGroup>
      <FieldDescription>
        {mode === "local" ? (
          <>
            <span className="font-medium text-success">Best for:</span> "near
            me" queries, city/county keywords, service-area pages.
          </>
        ) : (
          <>
            Local targeting can understate rankings for non-geo-modified terms.
          </>
        )}
      </FieldDescription>
      {mode === "local" && (
        <>
          <FieldLabel htmlFor={`${id}-city`} className="sr-only">
            City or region
          </FieldLabel>
          <SerpLocationCombobox
            brandKey={brandKey}
            id={`${id}-city`}
            value={locationName}
            onChange={onLocationNameChange}
            countryCode={countryCode}
            placeholder="Search cities..."
            invalid={Boolean(error)}
          />
        </>
      )}
      {error ? <FieldError>{error}</FieldError> : null}
    </FieldSet>
  );
}
