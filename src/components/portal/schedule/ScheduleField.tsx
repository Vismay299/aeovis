"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/rank-tracking/ScheduleField.tsx
//   src/client/features/rank-tracking/scheduleTime.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useId, useState } from "react";
import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  WEEKDAYS,
  browserTimeZoneLabel,
  describeSchedule,
  localScheduleTimeFrom,
  randomScheduleDate,
  type LocalScheduleTime,
  type ScheduleInterval,
  type ScheduleTime,
} from "@/shared/schedule";

export type ScheduleFieldValue = {
  interval: ScheduleInterval | "manual";
  scheduleTime?: ScheduleTime;
};

const SCHEDULE_ITEMS: { value: ScheduleInterval | "manual"; label: string }[] = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly (end of month)" },
  { value: "manual", label: "Manual only" },
];

const WEEKDAY_ITEMS = WEEKDAYS.map((day, index) => ({
  value: String(index),
  label: day,
}));

export type ScheduleFieldProps = {
  value: ScheduleFieldValue | ScheduleInterval | "manual";
  onChange: (value: ScheduleFieldValue) => void;
  disabled?: boolean;
  allowManual?: boolean;
  dailyNote?: string;
  schedule?: ScheduleInterval | "manual";
  onScheduleChange?: (schedule: ScheduleInterval | "manual") => void;
  scheduleTime?: LocalScheduleTime;
  onScheduleTimeChange?: (time: LocalScheduleTime) => void;
};

export function ScheduleField({
  value,
  onChange,
  disabled = false,
  allowManual = false,
  dailyNote = "Daily scans cost about 7 times as much as weekly.",
  schedule: compatSchedule,
  onScheduleChange,
  scheduleTime: compatScheduleTime,
  onScheduleTimeChange,
}: ScheduleFieldProps) {
  const id = useId();

  const currentInterval: ScheduleInterval | "manual" =
    compatSchedule ??
    (typeof value === "string" ? value : value?.interval ?? "weekly");

  const [internalTime, setInternalTime] = useState<LocalScheduleTime>(() => {
    if (compatScheduleTime) return compatScheduleTime;
    if (typeof value === "object" && value?.scheduleTime) {
      return {
        weekday: value.scheduleTime.weekday ?? 1,
        hour: value.scheduleTime.hour,
        minute: value.scheduleTime.minute,
      };
    }
    return localScheduleTimeFrom(randomScheduleDate());
  });

  const currentTime = compatScheduleTime ?? internalTime;
  const [showScheduleTime, setShowScheduleTime] = useState(false);

  const items = allowManual
    ? SCHEDULE_ITEMS
    : SCHEDULE_ITEMS.filter((item) => item.value !== "manual");

  function handleIntervalChange(newInterval: ScheduleInterval | "manual") {
    if (onScheduleChange) {
      onScheduleChange(newInterval);
    }
    onChange?.({
      interval: newInterval,
      scheduleTime: {
        weekday: currentTime.weekday,
        hour: currentTime.hour,
        minute: currentTime.minute,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    });
  }

  function handleTimeChange(updatedTime: LocalScheduleTime) {
    setInternalTime(updatedTime);
    if (onScheduleTimeChange) {
      onScheduleTimeChange(updatedTime);
    }
    onChange?.({
      interval: currentInterval,
      scheduleTime: {
        weekday: updatedTime.weekday,
        hour: updatedTime.hour,
        minute: updatedTime.minute,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    });
  }

  return (
    <Field>
      <FieldLabel htmlFor={id}>How often</FieldLabel>
      <Select
        items={items}
        disabled={disabled}
        value={currentInterval}
        onValueChange={(val) => {
          if (val) handleIntervalChange(val as ScheduleInterval | "manual");
        }}
      >
        <SelectTrigger
          id={id}
          aria-label="How often"
          data-testid="schedule-interval"
          className="w-full"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {currentInterval !== "manual" && (
        <FieldDescription>
          {describeSchedule(currentInterval, currentTime)}
          {!showScheduleTime && !disabled && (
            <>
              {" "}
              &middot;{" "}
              <Button
                type="button"
                variant="link"
                className="h-auto p-0 text-xs"
                onClick={() => setShowScheduleTime(true)}
              >
                change
              </Button>
            </>
          )}
        </FieldDescription>
      )}
      {currentInterval !== "manual" && showScheduleTime && (
        <>
          <div className="flex gap-2">
            {currentInterval === "weekly" && (
              <Select
                items={WEEKDAY_ITEMS}
                disabled={disabled}
                value={String(currentTime.weekday)}
                onValueChange={(weekdayStr) => {
                  if (weekdayStr !== null && weekdayStr !== undefined) {
                    handleTimeChange({ ...currentTime, weekday: Number(weekdayStr) });
                  }
                }}
              >
                <SelectTrigger aria-label="Day of week" className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WEEKDAY_ITEMS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Input
              type="time"
              disabled={disabled}
              className="w-auto"
              aria-label="Time of day"
              value={`${String(currentTime.hour).padStart(2, "0")}:${String(currentTime.minute).padStart(2, "0")}`}
              onChange={(e) => {
                const [h, m] = e.target.value.split(":").map(Number);
                if (Number.isNaN(h) || Number.isNaN(m)) return;
                handleTimeChange({ ...currentTime, hour: h, minute: m });
              }}
            />
          </div>
          <FieldDescription>
            In your local timezone: {browserTimeZoneLabel()}
          </FieldDescription>
        </>
      )}
      {currentInterval === "daily" && (
        <p className="flex items-start gap-1.5 text-xs text-warning">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          {dailyNote}
        </p>
      )}
    </Field>
  );
}
