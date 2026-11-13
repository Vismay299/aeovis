// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ga4/services/Ga4Dates.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

const DAY_MILLISECONDS = 86_400_000;

export function shiftGa4Date(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf())) throw new RangeError("Invalid GA4 date.");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function ga4DateInTimeZone(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const byType = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${byType.year}-${byType.month}-${byType.day}`;
}

export function inclusiveGa4Days(startDate: string, endDate: string): number {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  return Math.round((end.valueOf() - start.valueOf()) / DAY_MILLISECONDS) + 1;
}

const PRESET_DAYS: Record<string, number> = {
  last_7_days: 7,
  last_28_days: 28,
  last_90_days: 90,
};

export function presetRange(
  preset: string,
  timeZone: string,
  now: Date = new Date(),
): { startDate: string; endDate: string } {
  const days = PRESET_DAYS[preset] ?? 28;
  const lastCompleteDay = shiftGa4Date(ga4DateInTimeZone(now, timeZone), -1);
  const startDate = shiftGa4Date(lastCompleteDay, -(days - 1));
  return { startDate, endDate: lastCompleteDay };
}