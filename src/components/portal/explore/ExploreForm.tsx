"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/ai-search/components/PromptExplorerForm.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useState, useId } from "react";
import { Info } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
} from "@/components/ui/field";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import {
  Combobox,
  ComboboxInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxList,
  ComboboxItem,
} from "@/components/ui/combobox";
import {
  EXPLORE_MODELS,
  type ExploreModel,
  exploreModelLabel,
  countryLabel,
  supportsWebSearchCountry,
} from "@/shared/explore";
import { WEB_SEARCH_COUNTRY_CODES } from "@/shared/web-search-countries";
import { cn } from "@/lib/utils";

type Props = {
  defaultWorkspaceName?: string;
  defaultCountry?: string | null;
  initialValues?: {
    prompt?: string;
    models?: ExploreModel[];
    webSearch?: boolean;
    country?: string | null;
    highlightBrand?: string | null;
  };
  onSubmit: (values: {
    prompt: string;
    models: ExploreModel[];
    webSearch: boolean;
    country: string | null;
    highlightBrand: string | null;
  }) => void;
  disabled?: boolean;
  submitDisabled?: boolean;
};

type CountryItem = {
  code: string | null;
  label: string;
};

const COUNTRY_OPTIONS: CountryItem[] = [
  { code: null, label: "No country preference" },
  ...WEB_SEARCH_COUNTRY_CODES.map((code) => ({
    code,
    label: countryLabel(code),
  })),
];

function filterCountries(option: CountryItem, query: string): boolean {
  if (!query) return true;
  const needle = query.trim().toLowerCase();
  const label = option.label.toLowerCase();
  const code = option.code ? option.code.toLowerCase() : "";
  return (
    label.startsWith(needle) ||
    label.split(/[\s-]+/).some((w) => w.startsWith(needle)) ||
    code.startsWith(needle)
  );
}

export function ExploreForm({
  defaultWorkspaceName = "",
  defaultCountry = null,
  initialValues,
  onSubmit,
  disabled = false,
  submitDisabled = false,
}: Props) {
  const formId = useId();

  const [prompt, setPrompt] = useState(initialValues?.prompt ?? "");
  const [highlightBrand, setHighlightBrand] = useState(
    initialValues?.highlightBrand ?? "",
  );
  const [selectedModels, setSelectedModels] = useState<ExploreModel[]>(
    initialValues?.models && initialValues.models.length > 0
      ? initialValues.models
      : [...EXPLORE_MODELS],
  );
  const [webSearch, setWebSearch] = useState<boolean>(
    initialValues?.webSearch ?? true,
  );
  const [country, setCountry] = useState<string | null>(
    initialValues?.country !== undefined
      ? initialValues.country
      : defaultCountry,
  );

  const [validationError, setValidationError] = useState<string | null>(null);

  const trimmedPrompt = prompt.trim();
  const isPromptOverLimit = prompt.length > 500;
  const isBrandOverLimit = highlightBrand.length > 100;

  // Calculate models that are not skipped
  const activeSelectedModels = selectedModels.filter((m) => {
    if (!webSearch || !country) return true;
    return supportsWebSearchCountry(m, country);
  });

  const activeCount = activeSelectedModels.length;

  const handleModelToggle = (model: ExploreModel, checked: boolean) => {
    if (checked) {
      if (!selectedModels.includes(model)) {
        setSelectedModels([...selectedModels, model]);
      }
    } else {
      setSelectedModels(selectedModels.filter((m) => m !== model));
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);

    if (trimmedPrompt.length === 0) {
      setValidationError("Enter a question");
      return;
    }
    if (isPromptOverLimit) {
      setValidationError("Keep questions under 500 characters");
      return;
    }
    if (isBrandOverLimit) {
      setValidationError("Keep the brand under 100 characters");
      return;
    }
    if (selectedModels.length === 0) {
      setValidationError("Select at least one model");
      return;
    }

    onSubmit({
      prompt: trimmedPrompt,
      models: selectedModels,
      webSearch,
      country: webSearch ? country : null,
      highlightBrand: highlightBrand.trim() ? highlightBrand.trim() : null,
    });
  };

  const selectedCountryItem =
    COUNTRY_OPTIONS.find((c) => c.code === (country ?? null)) ?? COUNTRY_OPTIONS[0];

  return (
    <Card>
      <CardContent className="pt-6">
        <form onSubmit={handleSubmit} className="space-y-6">
          {validationError ? (
            <div role="alert" className="text-sm font-medium text-destructive">
              {validationError}
            </div>
          ) : null}

          {/* Question textarea */}
          <Field>
            <div className="flex items-center justify-between">
              <FieldLabel htmlFor={`${formId}-question`}>Question</FieldLabel>
              <span
                className={cn(
                  "text-xs tabular-nums",
                  isPromptOverLimit
                    ? "text-destructive font-medium"
                    : "text-muted-foreground",
                )}
              >
                {prompt.length}/500
              </span>
            </div>
            <Textarea
              id={`${formId}-question`}
              rows={3}
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value);
                if (validationError) setValidationError(null);
              }}
              placeholder="What your buyers might ask AI."
              disabled={disabled}
              className="resize-y"
            />
            <FieldDescription>What your buyers might ask AI.</FieldDescription>
          </Field>

          {/* Highlight brand */}
          <Field>
            <FieldLabel htmlFor={`${formId}-brand`}>
              Highlight brand (optional)
            </FieldLabel>
            <Input
              id={`${formId}-brand`}
              value={highlightBrand}
              onChange={(e) => {
                setHighlightBrand(e.target.value);
                if (validationError) setValidationError(null);
              }}
              placeholder={defaultWorkspaceName || "Acme"}
              disabled={disabled}
            />
            <FieldDescription>
              We flag whether each answer names this brand. Your own brand and its
              aliases are always checked.
            </FieldDescription>
          </Field>

          {/* Models */}
          <Field>
            <FieldLabel>Models</FieldLabel>
            <div className="grid grid-cols-2 sm:flex sm:flex-wrap sm:items-center gap-4 pt-1">
              {EXPLORE_MODELS.map((model) => {
                const checked = selectedModels.includes(model);
                const isSkipped =
                  webSearch && country && !supportsWebSearchCountry(model, country);
                const skippedLabel = isSkipped
                  ? `Skipped for ${countryLabel(country)}`
                  : null;

                return (
                  <div key={model} className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id={`${formId}-model-${model}`}
                        checked={checked}
                        onCheckedChange={(c) =>
                          handleModelToggle(model, Boolean(c))
                        }
                        disabled={disabled}
                      />
                      <Label
                        htmlFor={`${formId}-model-${model}`}
                        className="text-sm font-medium cursor-pointer"
                      >
                        {exploreModelLabel(model)}
                      </Label>
                    </div>
                    {skippedLabel ? (
                      <span className="text-xs text-muted-foreground pl-6">
                        {skippedLabel}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </Field>

          {/* Web search row */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-4 pt-1">
            <div className="flex items-center gap-2">
              <Checkbox
                id={`${formId}-web-search`}
                checked={webSearch}
                onCheckedChange={(c) => setWebSearch(Boolean(c))}
                disabled={disabled}
              />
              <Label
                htmlFor={`${formId}-web-search`}
                className="text-sm font-medium cursor-pointer whitespace-nowrap"
              >
                Allow web search
              </Label>
            </div>

            <div className="flex items-center gap-2 flex-1 min-w-0">
              <Combobox
                items={COUNTRY_OPTIONS}
                value={selectedCountryItem}
                itemToStringLabel={(item) => item.label}
                autoHighlight
                filter={filterCountries}
                onValueChange={(item) => {
                  if (item) setCountry(item.code);
                }}
              >
                <ComboboxInput
                  id={`${formId}-country`}
                  className="w-full sm:w-64"
                  placeholder="Search countries"
                  aria-label="Web search country"
                  disabled={disabled || !webSearch}
                />
                <ComboboxContent>
                  <ComboboxEmpty>No supported countries match.</ComboboxEmpty>
                  <ComboboxList>
                    {(item: CountryItem) => (
                      <ComboboxItem key={item.code ?? "none"} value={item}>
                        {item.label}
                      </ComboboxItem>
                    )}
                  </ComboboxList>
                </ComboboxContent>
              </Combobox>

              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground inline-flex items-center p-1"
                      aria-label="Country guidance information"
                    />
                  }
                >
                  <Info className="size-4 shrink-0" />
                </TooltipTrigger>
                <TooltipContent>
                  A country guides web search when a model supports it. Models may
                  answer without searching. Leave it unset to run all selected
                  models.
                </TooltipContent>
              </Tooltip>
            </div>
          </div>

          {/* Submit button */}
          <div>
            <Button
              type="submit"
              disabled={disabled || submitDisabled || activeCount === 0}
            >
              Ask {activeCount} {activeCount === 1 ? "model" : "models"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
