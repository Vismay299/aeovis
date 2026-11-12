"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/domain/components/DomainSearchCard.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { FormEvent } from "react";
import { LocationSelect } from "@/components/app/LocationSelect";
import { ResearchScopeSelect } from "@/components/app/ResearchScopeSelect";
import { SearchInput } from "@/components/app/SearchCard";
import { DomainPriceChangeReview } from "./DomainPriceChangeReview";
import type { DomainPriceChange } from "./DomainPriceChangeReview";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LABS_LOCATION_OPTIONS } from "@/shared/keyword-locations";
import {
  toSortMode,
  type DomainSortMode,
} from "@/shared/domain";
import type { ResearchScope } from "@/shared/researchScope";

const SORT_ITEMS: { value: DomainSortMode; label: string }[] = [
  { value: "rank", label: "By Rank" },
  { value: "traffic", label: "By Traffic" },
  { value: "volume", label: "By Volume" },
  { value: "score", label: "By Score" },
  { value: "cpc", label: "By CPC" },
];

type Props = {
  brandKey: string;
  domain: string;
  scope: ResearchScope;
  locationCode: number;
  sort: DomainSortMode;
  isLoading: boolean;
  validationError?: string | null;
  priceChanged?: DomainPriceChange | null;
  onDomainChange: (domain: string) => void;
  onScopeChange: (scope: ResearchScope) => void;
  onLocationChange: (locationCode: number) => void;
  onSortChange: (sort: DomainSortMode) => void;
  onSubmit: (maxUsd: number) => void;
};

export function DomainSearchCard({
  brandKey,
  domain,
  scope,
  locationCode,
  sort,
  isLoading,
  validationError,
  priceChanged,
  onDomainChange,
  onScopeChange,
  onLocationChange,
  onSortChange,
  onSubmit,
}: Props) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (validationError || !domain.trim()) return;
    // Enter follows the same quote and confirmation path as the visible Search button.
    event.currentTarget
      .querySelector<HTMLButtonElement>("button.domain-search-priced-action")
      ?.click();
  };

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <form noValidate className="space-y-3" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <SearchInput
              placeholder="Enter a domain or URL"
              aria-label="Domain or URL"
              value={domain}
              onChange={(event) => onDomainChange(event.target.value)}
              aria-invalid={validationError ? true : undefined}
              aria-describedby={validationError ? "domain-input-error" : undefined}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />

            <ResearchScopeSelect
              value={scope}
              className="w-full lg:w-40"
              onChange={onScopeChange}
            />

            <LocationSelect
              value={locationCode}
              options={LABS_LOCATION_OPTIONS}
              className="w-full lg:w-44 lg:shrink-0"
              onChange={onLocationChange}
            />

            <Select
              items={SORT_ITEMS}
              value={sort}
              onValueChange={(val) => {
                const next = toSortMode(val ?? "") ?? "traffic";
                onSortChange(next);
              }}
            >
              <SelectTrigger
                aria-label="Sort keywords"
                className="w-full shrink-0 lg:w-36"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORT_ITEMS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <DomainPriceChangeReview
              label="Search"
              pendingLabel="Searching..."
              brandKey={brandKey}
              action="domain.lookup.run"
              input={{
                domain: domain.trim(),
                scope,
                locationCode,
                tab: "keywords",
                pageSize: 50,
              }}
              enabled={Boolean(domain.trim() && !validationError)}
              pending={isLoading}
              onRun={onSubmit}
              priceChanged={priceChanged ?? null}
              dialogTitle="Search domain"
              confirmLabel="Search"
              className="domain-search-priced-action"
            />
          </div>
          <button type="submit" aria-hidden="true" tabIndex={-1} className="sr-only">
            Submit Search
          </button>
        </form>

        {validationError ? (
          <p id="domain-input-error" role="alert" className="text-sm text-destructive">
            {validationError}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
