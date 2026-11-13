// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/SerpLocationCombobox.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MapPin } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  useComboboxAnchor,
} from "@/components/ui/combobox";
import { InputGroupAddon } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { fetchJson, withBrand } from "@/lib/query/fetchJson";
import { keys } from "@/lib/query/keys";
import { formatLocationLabel } from "@/shared/keyword-locations";

export type SerpLocationOption = {
  locationName: string;
  displayLabel: string;
  locationType?: string;
};

type Props = {
  brandKey: string;
  value: string | undefined;
  onChange: (locationName: string | undefined) => void;
  /** ISO 3166-1 alpha-2 country code, e.g. "us". */
  countryCode: string;
  placeholder?: string;
  id?: string;
  invalid?: boolean;
  "aria-label"?: string;
};

function useDebounce<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export function fetchSerpLocations(brandKey: string, countryCode: string, q: string) {
  return fetchJson<{ locations: SerpLocationOption[] }>(
    withBrand("/api/customer/keywords/locations", brandKey, { country: countryCode, q }),
  ).then((body) => body.locations);
}

/** Searches the cities, counties and regions of one country (F15 and F17 reuse it). */
export function SerpLocationCombobox({
  brandKey,
  value,
  onChange,
  countryCode,
  placeholder = "Search cities...",
  id,
  invalid,
  "aria-label": ariaLabel,
}: Props) {
  // The list lines up with the whole field, not only the text input.
  const anchor = useComboboxAnchor();
  const [query, setQuery] = useState("");
  const trimmed = query.trim();
  const debounced = useDebounce(trimmed, 350);

  const searchQuery = useQuery({
    queryKey: keys.keywordLocations(brandKey, countryCode, debounced),
    queryFn: () => fetchSerpLocations(brandKey, countryCode, debounced),
    enabled: Boolean(brandKey) && debounced !== "",
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const searching = trimmed !== "" && (trimmed !== debounced || searchQuery.isFetching);
  // Only show matches for the text in the field right now.
  const results = searching || !trimmed ? [] : (searchQuery.data ?? []);

  const selected: SerpLocationOption | null = value
    ? { locationName: value, displayLabel: formatLocationLabel(value) }
    : null;

  const emptyMessage = !trimmed
    ? "Type a city, county, or region"
    : searching
      ? "Searching..."
      : searchQuery.isError
        ? "Unable to load locations"
        : `No locations found for "${trimmed}"`;

  return (
    <Combobox
      items={results}
      value={selected}
      // The server already matched the query.
      filter={null}
      itemToStringLabel={(item: SerpLocationOption) => item.displayLabel}
      isItemEqualToValue={(item, current) => item.locationName === current.locationName}
      onValueChange={(item) => {
        setQuery("");
        onChange(item?.locationName);
      }}
      // A closed list drops its search, so the next open starts fresh.
      onOpenChange={(open) => {
        if (!open) setQuery("");
      }}
      onInputValueChange={(text, { reason }) => {
        if (reason !== "input-change") return;
        setQuery(text);
        if (!text.trim()) onChange(undefined);
      }}
    >
      <div ref={anchor}>
        <ComboboxInput
          id={id}
          aria-label={ariaLabel}
          aria-invalid={invalid || undefined}
          className="w-full"
          placeholder={placeholder}
          showTrigger={false}
        >
          <InputGroupAddon align="inline-start">
            {searching ? <Spinner /> : <MapPin aria-hidden="true" />}
          </InputGroupAddon>
        </ComboboxInput>
      </div>
      {/* Full labels such as "Orange County, California, United States" are
          wider than a compact field, so the list sizes to its content. */}
      <ComboboxContent anchor={anchor} className="w-max">
        <ComboboxEmpty>{emptyMessage}</ComboboxEmpty>
        <ComboboxList>
          {(item: SerpLocationOption) => (
            <ComboboxItem key={item.locationName} value={item}>
              <span className="truncate">{item.displayLabel}</span>
              {item.locationType ? (
                <Badge variant="secondary" className="ml-auto">
                  {item.locationType}
                </Badge>
              ) : null}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
