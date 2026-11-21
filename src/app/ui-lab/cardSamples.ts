/**
 * Sample data for the Kokonut data cards in the UI lab only. The product never
 * renders this: the Overview cards take `dailyMentions` and `engines` from
 * GET /api/customer/overview. Shaped like the real data — scans on a few days,
 * every other day unknown (null / "none"), one engine with failed days.
 */
import type { MetricPoint } from "@/components/kokonutui/metric-card";
import type { DayStatus, UptimeService } from "@/components/kokonutui/uptime-card";

const DAYS = 90;
const DAY = 86_400_000;
export const SAMPLE_END = "2026-10-14";
export const SAMPLE_ENGINES = ["ChatGPT", "Gemini", "Perplexity", "Google AI Overviews"];

// Scan days, as days before SAMPLE_END: weekly, with a missed week and one
// back-to-back pair.
const SCAN_DAYS = new Set([84, 77, 70, 56, 49, 42, 35, 28, 21, 14, 8, 7, 0]);
const FAILED: Record<string, number[]> = { Gemini: [42, 8] };
const NOT_ASSESSED: Record<string, number[]> = { "Google AI Overviews": [70, 56] };

const dateAt = (index: number) =>
  new Date(Date.parse(`${SAMPLE_END}T00:00:00Z`) - (DAYS - 1 - index) * DAY)
    .toISOString()
    .slice(0, 10);

// Seeded, so server and browser draw the same chart.
function seeded() {
  let seed = 42;
  return () => {
    seed = (seed * 16_807) % 2_147_483_647;
    return seed / 2_147_483_647;
  };
}

function build() {
  const random = seeded();
  const mentions: MetricPoint[] = [];
  const status: Record<string, DayStatus[]> = Object.fromEntries(
    SAMPLE_ENGINES.map((name) => [name, []]),
  );
  for (let i = 0; i < DAYS; i++) {
    const ago = DAYS - 1 - i;
    if (!SCAN_DAYS.has(ago)) {
      mentions.push({ date: dateAt(i), value: null, parts: SAMPLE_ENGINES.map(() => null) });
      for (const name of SAMPLE_ENGINES) status[name].push("none");
      continue;
    }
    const lift = (DAYS - ago) / 30;
    const parts = SAMPLE_ENGINES.map((name) => {
      if (FAILED[name]?.includes(ago)) {
        status[name].push("down");
        return null;
      }
      status[name].push(NOT_ASSESSED[name]?.includes(ago) ? "unassessed" : "up");
      return Math.round(4 + lift * 2 + random() * 5);
    });
    const best = Math.max(0, ...parts.filter((p): p is number => p !== null));
    mentions.push({ date: dateAt(i), value: best + Math.round(2 + random() * 4), parts });
  }
  const engines: UptimeService[] = SAMPLE_ENGINES.map((name) => ({ name, days: status[name] }));
  return { mentions, engines };
}

export const SAMPLE = build();
