"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/domain/components/DomainFilterPanel.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { AlertTriangle } from "lucide-react";
import {
  DataTableFilterGroup,
  DataTableFilterPanel,
  DataTableRangeFilter,
} from "@/components/app/table/DataTableToolbar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MAX_DATAFORSEO_FILTER_CONDITIONS } from "@/shared/researchScope";

type FilterValues = Record<string, string>;

export type FilterTextField<TValues extends FilterValues> = {
  key: keyof TValues;
  label: string;
  placeholder: string;
};

export type FilterRangeField<TValues extends FilterValues> = {
  title: string;
  minKey: keyof TValues;
  maxKey: keyof TValues;
  step?: string;
};

type Props<TValues extends FilterValues> = {
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
};

export function DomainFilterPanel<TValues extends FilterValues>({
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
}: Props<TValues>) {
  const appliedKey = useMemo(
    () => fields.map((key) => appliedFilters[key] ?? "").join("|"),
    [appliedFilters, fields],
  );
  const [draftFilters, setDraftFilters] = useState<TValues>(appliedFilters);

  useEffect(() => {
    setDraftFilters(appliedFilters);
  }, [appliedKey]);

  const conditionCount = useMemo(
    () => countConditions(draftFilters),
    [countConditions, draftFilters],
  );

  const dirtyCount = useMemo(
    () =>
      fields.reduce(
        (acc, key) =>
          acc +
          ((draftFilters[key] ?? "").trim() !==
          (appliedFilters[key] ?? "").trim()
            ? 1
            : 0),
        0,
      ),
    [appliedFilters, draftFilters, fields],
  );

  const isDirty = dirtyCount > 0;
  const overLimit = conditionCount > maxConditions;

  const applyFilters = useCallback(() => {
    if (overLimit) return;
    onApply(draftFilters);
  }, [draftFilters, onApply, overLimit]);

  const cancelFilterEdits = useCallback(() => {
    setDraftFilters(appliedFilters);
  }, [appliedFilters]);

  const resetFilters = useCallback(() => {
    setDraftFilters((current) => {
      const next = { ...current };
      for (const key of fields) {
        (next as any)[key] = "";
      }
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
                value={draftFilters[field.key] ?? ""}
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
                value: draftFilters[field.minKey] ?? "",
                onChange: (event) =>
                  handleValueChange(field.minKey, event.target.value),
              }}
              max={{
                step: field.step,
                value: draftFilters[field.maxKey] ?? "",
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
              {`Too many filter conditions (${conditionCount} of ${maxConditions}). Remove some to apply.`}
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
              type="button"
              variant="ghost"
              size="sm"
              onClick={cancelFilterEdits}
              disabled={!isDirty}
            >
              Cancel
            </Button>
            <Button
              type="button"
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
