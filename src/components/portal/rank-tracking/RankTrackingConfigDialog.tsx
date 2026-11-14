// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/rank-tracking/RankTrackingConfigModal.tsx:86-412
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useId, useMemo, useState } from "react";
import { Info } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CountryCombobox } from "@/components/app/CountryCombobox";
import { ScheduleField, type ScheduleFieldValue } from "@/components/portal/schedule/ScheduleField";
import {
  LOCATION_OPTIONS,
  SERP_LANGUAGE_OPTIONS,
  getIsoCountryCode,
  getLanguageCode,
  workspaceMarket,
} from "@/shared/keyword-locations";
import {
  pagesToDepth,
  type Devices,
  type RankSchedule,
} from "@/shared/rank-tracking";
import {
  localScheduleTimeFrom,
  randomScheduleDate,
  withBrowserTimeZone,
  type LocalScheduleTime,
} from "@/shared/schedule";
import { isApiError } from "@/lib/query/fetchJson";
import { CostEstimateBox } from "./CostEstimateBox";
import { FirstCheckStep } from "./FirstCheckStep";
import { KeywordSuggestionStep } from "./KeywordSuggestionStep";
import { SearchTargetingField, type TargetingMode } from "./SearchTargetingField";
import { useSaveConfigMutations, type SaveConfigInput } from "./hooks/useSaveConfigMutations";
import type { RankTrackerSummary } from "./hooks/useRankTrackers";

const LANGUAGE_ITEMS = SERP_LANGUAGE_OPTIONS.map((language) => ({
  value: language.code,
  label: language.label,
}));

const DEVICE_ITEMS: { value: Devices; label: string }[] = [
  { value: "mobile", label: "Mobile only" },
  { value: "desktop", label: "Desktop only" },
  { value: "both", label: "Desktop + Mobile" },
];

const DEPTH_ITEMS = Array.from({ length: 10 }, (_, i) => i + 1).map(
  (pages) => ({
    value: String(pagesToDepth(pages)),
    label: `${pages} ${pages === 1 ? "page" : "pages"} (top ${pages * 10} results)`,
  }),
);

const DOMAIN_PATTERN =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function defaultDomainForWebsite(website: string | null): string {
  const host = (website ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .replace(/^www\./, "");
  return host;
}

export function normalizeDomainInput(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .split("?")[0]
    .replace(/^www\./, "")
    .replace(/\.$/, "");
}

function isValidDomain(domain: string): boolean {
  return (
    domain.length >= 3 &&
    domain.length <= 253 &&
    DOMAIN_PATTERN.test(domain) &&
    !domain.startsWith("www.")
  );
}

type Draft = {
  domain: string;
  locationCode: number;
  languageCode: string;
  targetingMode: TargetingMode;
  locationName: string | undefined;
  devices: Devices;
  schedule: RankSchedule;
  scheduleTime: LocalScheduleTime;
  serpDepth: number;
};

function draftFor(
  existingConfig: RankTrackerSummary | null,
  website: string | null,
): Draft {
  if (existingConfig) {
    return {
      domain: existingConfig.domain,
      locationCode: existingConfig.locationCode,
      languageCode: existingConfig.languageCode,
      targetingMode: existingConfig.locationName ? "local" : "national",
      locationName: existingConfig.locationName ?? undefined,
      devices: existingConfig.devices,
      schedule: existingConfig.scheduleInterval,
      scheduleTime: localScheduleTimeFrom(
        existingConfig.nextCheckAt
          ? new Date(existingConfig.nextCheckAt)
          : randomScheduleDate(),
      ),
      serpDepth: existingConfig.serpDepth,
    };
  }
  const market = workspaceMarket({ website_host: website ?? "" });
  return {
    domain: defaultDomainForWebsite(website),
    locationCode: market.locationCode,
    languageCode: market.languageCode,
    targetingMode: "national",
    locationName: undefined,
    devices: "mobile",
    schedule: "weekly",
    scheduleTime: localScheduleTimeFrom(randomScheduleDate()),
    serpDepth: 40,
  };
}

export function RankTrackingConfigDialog({
  brandKey,
  website,
  existingConfig,
  onClose,
  onSaved,
}: {
  brandKey: string;
  website: string | null;
  existingConfig?: RankTrackerSummary | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const countryId = useId();
  const isEdit = Boolean(existingConfig);
  const [draft, setDraft] = useState<Draft>(() =>
    draftFor(existingConfig ?? null, website),
  );
  const [errors, setErrors] = useState<{ domain?: string; locationName?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [scheduleTimeEdited, setScheduleTimeEdited] = useState(false);
  const [created, setCreated] = useState<{
    configId: string;
    nextCheckAt: string | null;
    devices: Devices;
    scheduleInterval: RankSchedule;
    approvedMaxUsd: number | null;
  } | null>(null);
  const [savedKeywordCount, setSavedKeywordCount] = useState(0);

  const { createMutation, updateMutation } = useSaveConfigMutations({
    brandKey,
    existingConfig,
    onCreated: (configId, tracker) => {
      setCreated({
        configId,
        nextCheckAt: tracker.nextCheckAt,
        devices: tracker.devices,
        scheduleInterval: tracker.scheduleInterval,
        approvedMaxUsd: tracker.approvedMaxUsd,
      });
    },
    onUpdated: () => onSaved(),
  });

  const pending = createMutation.isPending || updateMutation.isPending;

  const patch = (next: Partial<Draft>) => {
    setDraft((prev) => ({ ...prev, ...next }));
    setFormError(null);
  };

  const scheduleValue: ScheduleFieldValue = useMemo(
    () => ({ interval: draft.schedule, scheduleTime: undefined }),
    [draft.schedule],
  );

  async function handleSubmit() {
    const domain = normalizeDomainInput(draft.domain);
    const nextErrors: { domain?: string; locationName?: string } = {};
    if (!domain) {
      nextErrors.domain = "Enter a domain";
    } else if (!isValidDomain(domain)) {
      nextErrors.domain = "Enter a valid domain, like example.com";
    }
    if (draft.targetingMode === "local" && !draft.locationName) {
      nextErrors.locationName = "Select a city or region for local targeting";
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    const sendScheduleTime =
      draft.schedule !== "manual" &&
      (!existingConfig ||
        scheduleTimeEdited ||
        draft.schedule !== existingConfig.scheduleInterval);
    const input: SaveConfigInput = {
      domain,
      devices: draft.devices,
      serpDepth: draft.serpDepth,
      locationCode: draft.locationCode,
      languageCode: draft.languageCode,
      targetingMode: draft.targetingMode,
      locationName: draft.locationName,
      schedule: draft.schedule,
      scheduleTime: sendScheduleTime
        ? withBrowserTimeZone(draft.scheduleTime)
        : undefined,
    };
    setFormError(null);
    try {
      if (isEdit) {
        await updateMutation.mutateAsync(input);
      } else {
        await createMutation.mutateAsync(input);
      }
    } catch (err) {
      setFormError(
        isApiError(err)
          ? err.message
          : "The domain could not be saved. Please retry.",
      );
    }
  }

  const closeKeywordStep = () => onSaved();

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (open || pending) return;
        if (created) closeKeywordStep();
        else onClose();
      }}
    >
      <DialogContent
        showCloseButton={Boolean(created)}
        fullScreenOnMobile
        className={created ? "sm:max-w-3xl" : "sm:max-w-lg"}
      >
        {created ? (
          savedKeywordCount > 0 ? (
            <FirstCheckStep
              brandKey={brandKey}
              configId={created.configId}
              nextCheckAt={created.nextCheckAt}
              keywordCount={savedKeywordCount}
              onDone={() => onSaved()}
              onClose={() => onSaved()}
            />
          ) : (
            <KeywordSuggestionStep
              brandKey={brandKey}
              configId={created.configId}
              domain={draft.domain}
              locationCode={draft.locationCode}
              devices={created.devices}
              scheduleInterval={created.scheduleInterval}
              approvedMaxUsd={created.approvedMaxUsd}
              onSaved={(added) => setSavedKeywordCount(added)}
              onClose={closeKeywordStep}
            />
          )
        ) : (
          <div className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>
                {isEdit ? "Edit Domain Config" : "Add Domain"}
              </DialogTitle>
            </DialogHeader>

            <Field>
              <FieldLabel htmlFor={`${countryId}-domain`}>
                Target Domain
              </FieldLabel>
              <Input
                id={`${countryId}-domain`}
                placeholder="example.com"
                value={draft.domain}
                disabled={pending}
                aria-invalid={Boolean(errors.domain) || undefined}
                onChange={(event) =>
                  patch({ domain: event.target.value })
                }
                onBlur={(event) => {
                  const normalized = normalizeDomainInput(event.target.value);
                  if (normalized !== event.target.value) {
                    patch({ domain: normalized });
                  }
                }}
              />
              {errors.domain ? (
                <p className="text-xs text-destructive">{errors.domain}</p>
              ) : null}
            </Field>

            <Field>
              <FieldLabel htmlFor={countryId}>Country</FieldLabel>
              <CountryCombobox
                id={countryId}
                value={draft.locationCode}
                onChange={(locationCode) => {
                  patch({
                    locationCode,
                    // A picked city belongs to the previous country.
                    languageCode: getLanguageCode(locationCode),
                    locationName: undefined,
                  });
                }}
                options={LOCATION_OPTIONS}
              />
            </Field>

            <SearchTargetingField
              brandKey={brandKey}
              mode={draft.targetingMode}
              onModeChange={(mode) => patch({ targetingMode: mode })}
              locationName={draft.locationName}
              onLocationNameChange={(locationName) =>
                patch({ locationName })
              }
              countryCode={getIsoCountryCode(draft.locationCode)}
              error={errors.locationName}
            />

            <Field>
              <FieldLabel htmlFor={`${countryId}-language`}>Language</FieldLabel>
              <Select
                items={LANGUAGE_ITEMS}
                value={draft.languageCode}
                onValueChange={(value) => {
                  if (value) patch({ languageCode: value });
                }}
              >
                <SelectTrigger id={`${countryId}-language`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LANGUAGE_ITEMS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Defaults to the country&apos;s language. Any language can be
                tracked in any country. Pick the one your customers search in.
              </p>
            </Field>

            <div className="flex flex-col gap-1.5">
              <Field>
                <FieldLabel htmlFor={`${countryId}-devices`}>
                  Devices
                </FieldLabel>
                <Select
                  items={DEVICE_ITEMS}
                  value={draft.devices}
                  onValueChange={(value) => {
                    if (value) patch({ devices: value as Devices });
                  }}
                >
                  <SelectTrigger id={`${countryId}-devices`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DEVICE_ITEMS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Most Google searches come from mobile, but choose what your
                  customers use.
                </p>
              </Field>
              {draft.devices === "both" && (
                <p className="flex items-start gap-1.5 text-xs text-info">
                  <Info className="mt-0.5 size-3.5 shrink-0" />
                  Tracking both devices doubles the cost of every check.
                </p>
              )}
            </div>

            <ScheduleField
              value={scheduleValue}
              onChange={(value) => {
                patch({
                  schedule: value.interval,
                  scheduleTime: value.scheduleTime
                    ? {
                        weekday: value.scheduleTime.weekday ?? 1,
                        hour: value.scheduleTime.hour,
                        minute: value.scheduleTime.minute,
                      }
                    : draft.scheduleTime,
                });
                setScheduleTimeEdited(true);
              }}
              disabled={pending}
              allowManual
              dailyNote="Daily checks cost about 7 times as much as weekly."
            />

            <Field>
              <FieldLabel htmlFor={`${countryId}-depth`}>
                Search Depth
              </FieldLabel>
              <Select
                items={DEPTH_ITEMS}
                value={String(draft.serpDepth)}
                onValueChange={(value) => {
                  if (value) patch({ serpDepth: Number(value) });
                }}
              >
                <SelectTrigger id={`${countryId}-depth`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DEPTH_ITEMS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                10 pages is about 8 times as expensive as 1 page.
              </p>
            </Field>

            <CostEstimateBox
              brandKey={brandKey}
              devices={draft.devices}
              serpDepth={draft.serpDepth}
              scheduleInterval={draft.schedule}
            />

            {formError ? (
              <Alert variant="destructive">
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            ) : null}

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={onClose}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button pending={pending} onClick={() => void handleSubmit()}>
                {isEdit ? "Save Changes" : "Add Domain"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
