"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/backlinks/BacklinksFilterPanel.tsx
//   src/client/features/domain/components/DomainFilterPanel.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { AlertTriangle, Link, Link2, Unlink } from "lucide-react";
import { SegmentedToggle } from "@/components/app/SegmentedToggle";
import {
  DataTableFilterGroup,
  DataTableFilterPanel,
  DataTableRangeFilter,
} from "@/components/app/table/DataTableToolbar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MAX_DATAFORSEO_FILTER_CONDITIONS } from "@/shared/researchScope";
import {
  BACKLINKS_FILTER_FIELDS,
  REFERRING_DOMAINS_FILTER_FIELDS,
  TOP_PAGES_FILTER_FIELDS,
  countFilterConditions,
  type BacklinksTab,
  type BacklinksTabFilterValues,
  type ReferringDomainsFilterValues,
  type TopPagesFilterValues,
} from "@/shared/backlinks";
import type { BacklinksFiltersState } from "./hooks/useBacklinksFilters";

type FilterValues = Record<string, string>;

type FilterTextField<TValues extends FilterValues> = {
  key: keyof TValues;
  label: string;
  placeholder: string;
};

type FilterRangeField<TValues extends FilterValues> = {
  title: string;
  minKey: keyof TValues;
  maxKey: keyof TValues;
  step?: string;
};

function GenericFilterPanel<TValues extends FilterValues>({
  activeFilterCount,
  appliedFilters,
  fields,
  textFields,
  rangeFields,
  countConditions,
  maxConditions = MAX_DATAFORSEO_FILTER_CONDITIONS,
  onApply,
  onClear,
  renderExtra,
}: {
  activeFilterCount: number;
  appliedFilters: TValues;
  fields: ReadonlyArray<keyof TValues>;
  textFields: ReadonlyArray<FilterTextField<TValues>>;
  rangeFields: ReadonlyArray<FilterRangeField<TValues>>;
  countConditions: (values: TValues) => number;
  maxConditions?: number;
  onApply: (values: TValues) => void;
  onClear: () => void;
  renderExtra?: (
    draft: TValues,
    setValue: (key: keyof TValues, value: string) => void,
  ) => ReactNode;
}) {
  const appliedKey = useMemo(
    () => fields.map((key) => appliedFilters[key]).join("|"),
    [appliedFilters, fields],
  );
  const [draftFilters, setDraftFilters] = useState(appliedFilters);

  useEffect(() => {
    setDraftFilters(appliedFilters);
  }, [appliedFilters, appliedKey]);

  const conditionCount = countConditions(draftFilters);
  const dirtyCount = fields.reduce(
    (acc, key) =>
      acc + (draftFilters[key].trim() !== appliedFilters[key].trim() ? 1 : 0),
    0,
  );
  const isDirty = dirtyCount > 0;
  const overLimit = conditionCount > maxConditions;

  const applyFilters = useCallback(() => {
    if (overLimit) return;
    onApply(draftFilters);
  }, [draftFilters, overLimit, onApply]);

  const cancelFilterEdits = useCallback(() => {
    setDraftFilters(appliedFilters);
  }, [appliedFilters]);

  const resetFilters = useCallback(() => {
    setDraftFilters((current) => {
      const next = { ...current };
      for (const key of fields) Object.assign(next, { [key]: "" });
      return next;
    });
    onClear();
  }, [fields, onClear]);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "Enter") return;
    if (event.target instanceof HTMLButtonElement) return;
    if (overLimit) return;
    event.preventDefault();
    applyFilters();
  };

  const handleValueChange = useCallback((key: keyof TValues, value: string) => {
    setDraftFilters((current) => ({ ...current, [key]: value }));
  }, []);

  return (
    <DataTableFilterPanel
      activeCount={activeFilterCount}
      onReset={resetFilters}
    >
      <div className="space-y-3" onKeyDown={handleKeyDown}>
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
          {textFields.map((field) => (
            <DataTableFilterGroup key={String(field.key)} label={field.label}>
              <Input
                className="h-7"
                aria-label={field.label}
                placeholder={field.placeholder}
                value={draftFilters[field.key]}
                onChange={(event) =>
                  handleValueChange(field.key, event.target.value)
                }
              />
            </DataTableFilterGroup>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {rangeFields.map((field) => (
            <DataTableRangeFilter
              key={String(field.minKey)}
              label={field.title}
              min={{
                step: field.step,
                value: draftFilters[field.minKey],
                onChange: (event) =>
                  handleValueChange(field.minKey, event.target.value),
              }}
              max={{
                step: field.step,
                value: draftFilters[field.maxKey],
                onChange: (event) =>
                  handleValueChange(field.maxKey, event.target.value),
              }}
            />
          ))}
        </div>

        {renderExtra ? renderExtra(draftFilters, handleValueChange) : null}

        {overLimit ? (
          <Alert variant="warning">
            <AlertTriangle />
            <AlertDescription className="text-foreground">
              Too many filter conditions ({conditionCount} of {maxConditions}{" "}
              max). Remove some terms or ranges before applying.
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground tabular-nums">
              {conditionCount} / {maxConditions} conditions
            </span>
            {dirtyCount > 0 ? (
              <Badge size="sm" variant="warning">
                {dirtyCount} unapplied
              </Badge>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={cancelFilterEdits}
              disabled={!isDirty}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={applyFilters}
              disabled={!isDirty || overLimit}
              title={
                overLimit
                  ? `This scope leaves room for at most ${maxConditions} filter conditions per request`
                  : undefined
              }
            >
              Apply filters
              {isDirty ? (
                <Badge size="sm" variant="secondary">
                  {dirtyCount}
                </Badge>
              ) : null}
            </Button>
          </div>
        </div>
      </div>
    </DataTableFilterPanel>
  );
}

const LINK_TYPE_ITEMS = [
  { value: "all", icon: <Link2 />, label: "All" },
  { value: "dofollow", icon: <Link />, label: "Dofollow" },
  { value: "nofollow", icon: <Unlink />, label: "Nofollow" },
];

function BacklinksToggleControls({
  draft,
  setValue,
}: {
  draft: BacklinksTabFilterValues;
  setValue: (key: keyof BacklinksTabFilterValues, value: string) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <DataTableFilterGroup label="Link Type">
        <SegmentedToggle
          showLabels
          items={LINK_TYPE_ITEMS}
          value={draft.linkType || "all"}
          onChange={(value) =>
            setValue("linkType", value === "all" ? "" : value)
          }
        />
      </DataTableFilterGroup>

      <DataTableFilterGroup label="Visibility">
        <div className="flex h-7 items-center gap-4">
          <VisibilityCheckbox
            label="Hide lost"
            checked={draft.hideLost === "true"}
            onCheckedChange={(checked) =>
              setValue("hideLost", checked ? "true" : "")
            }
          />
          <VisibilityCheckbox
            label="Hide broken"
            checked={draft.hideBroken === "true"}
            onCheckedChange={(checked) =>
              setValue("hideBroken", checked ? "true" : "")
            }
          />
        </div>
      </DataTableFilterGroup>
    </div>
  );
}

function VisibilityCheckbox({
  label,
  checked,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={onCheckedChange} />
      <Label htmlFor={id} className="text-xs font-normal">
        {label}
      </Label>
    </div>
  );
}

export function BacklinksFilterPanel({
  activeTab,
  filters,
  onApplied,
  maxConditions,
}: {
  activeTab: BacklinksTab;
  filters: BacklinksFiltersState;
  onApplied: () => void;
  maxConditions?: number;
}) {
  if (activeTab === "backlinks") {
    const state = filters.backlinks;
    return (
      <GenericFilterPanel
        key="backlinks"
        appliedFilters={state.values}
        fields={BACKLINKS_FILTER_FIELDS}
        activeFilterCount={state.activeFilterCount}
        countConditions={countFilterConditions}
        maxConditions={maxConditions}
        textFields={[
          {
            key: "include",
            label: "Source URL Contains",
            placeholder: "example.com, blog",
          },
          {
            key: "exclude",
            label: "Source URL Excludes",
            placeholder: "spam, forum",
          },
        ]}
        rangeFields={[
          {
            title: "Domain Authority",
            minKey: "minDomainRank",
            maxKey: "maxDomainRank",
          },
          {
            title: "Link Authority",
            minKey: "minLinkAuthority",
            maxKey: "maxLinkAuthority",
          },
          {
            title: "Spam Score",
            minKey: "minSpamScore",
            maxKey: "maxSpamScore",
            step: "0.1",
          },
        ]}
        onApply={(values) => {
          state.apply(values);
          onApplied();
        }}
        onClear={() => {
          state.reset();
          onApplied();
        }}
        renderExtra={(draft, setValue) => (
          <BacklinksToggleControls draft={draft} setValue={setValue} />
        )}
      />
    );
  }

  if (activeTab === "domains") {
    const state = filters.domains;
    return (
      <GenericFilterPanel
        key="domains"
        appliedFilters={state.values}
        fields={REFERRING_DOMAINS_FILTER_FIELDS}
        activeFilterCount={state.activeFilterCount}
        countConditions={countFilterConditions}
        maxConditions={maxConditions}
        textFields={[
          {
            key: "include",
            label: "Domain Contains",
            placeholder: "example.com, blog",
          },
          {
            key: "exclude",
            label: "Domain Excludes",
            placeholder: "spam, forum",
          },
        ]}
        rangeFields={[
          {
            title: "Backlinks",
            minKey: "minBacklinks",
            maxKey: "maxBacklinks",
          },
          { title: "Rank", minKey: "minRank", maxKey: "maxRank" },
          {
            title: "Spam Score",
            minKey: "minSpamScore",
            maxKey: "maxSpamScore",
            step: "0.1",
          },
        ]}
        onApply={(values) => {
          state.apply(values);
          onApplied();
        }}
        onClear={() => {
          state.reset();
          onApplied();
        }}
      />
    );
  }

  const state = filters.pages;
  return (
    <GenericFilterPanel
      key="pages"
      appliedFilters={state.values}
      fields={TOP_PAGES_FILTER_FIELDS}
      activeFilterCount={state.activeFilterCount}
      countConditions={countFilterConditions}
      maxConditions={maxConditions}
      textFields={[
        {
          key: "include",
          label: "Page URL Contains",
          placeholder: "/blog, /products",
        },
        {
          key: "exclude",
          label: "Page URL Excludes",
          placeholder: "/tag, /author",
        },
      ]}
      rangeFields={[
        { title: "Backlinks", minKey: "minBacklinks", maxKey: "maxBacklinks" },
        {
          title: "Referring Domains",
          minKey: "minReferringDomains",
          maxKey: "maxReferringDomains",
        },
        { title: "Rank", minKey: "minRank", maxKey: "maxRank" },
      ]}
      onApply={(values) => {
        state.apply(values);
        onApplied();
      }}
      onClear={() => {
        state.reset();
        onApplied();
      }}
    />
  );
}
