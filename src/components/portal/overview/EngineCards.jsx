"use client";

/**
 * T9 — "Answers naming you" (MetricCard) and "Answer engines" (UptimeCard),
 * from the overview's `dailyMentions` and `engines`. Days without a scan stay
 * unknown in both cards; with no scan history at all, the page's empty-state
 * card renders instead of a chart.
 */

import { History } from "lucide-react";
import MetricCard from "@/components/kokonutui/metric-card";
import UptimeCard from "@/components/kokonutui/uptime-card";
import { engineLabel } from "@/components/portal/scans/reportData";
import { Card, EmptyState, Skeleton } from "../ui";
import { engineKeys, engineStatusRows, historyEndDate, mentionSeries } from "./overviewModel";

const PERIODS = [7, 30, 90];

/** The shortest period holding two scans or more, so the card opens on a line. */
function openingPeriod(points) {
  for (const days of PERIODS) {
    const scans = points.slice(-days).filter((p) => p.value !== null).length;
    if (scans >= 2) return days;
  }
  return PERIODS[PERIODS.length - 1];
}

function EmptyCard({ title, children }) {
  return (
    <Card title={title}>
      <EmptyState icon={History} title="Nothing measured yet">
        {children}
      </EmptyState>
    </Card>
  );
}

export default function EngineCards({ overview }) {
  if (!overview) {
    return (
      <div className="grid items-start gap-5 lg:grid-cols-2" aria-busy="true" aria-label="Loading scan history">
        <Skeleton height={320} />
        <Skeleton height={320} />
      </div>
    );
  }

  const keys = engineKeys(overview);
  const points = mentionSeries(overview, keys);
  const rows = engineStatusRows(overview, engineLabel);
  const endDate = historyEndDate(overview);
  const hasMentions = points.some((p) => p.value !== null);
  const hasEngines = endDate !== null && rows.some((row) => row.days.some((status) => status !== "none"));

  if (!hasMentions && !hasEngines) {
    return (
      <Card title="Scan history" description="Answers naming you and how each AI engine answered, scan by scan">
        <EmptyState icon={History} title="Your history appears after your first scan">
          Each scan records how many answers name you and whether each AI engine answered.
        </EmptyState>
      </Card>
    );
  }

  return (
    <div className="grid items-start gap-5 lg:grid-cols-2">
      {hasMentions ? (
        <MetricCard
          label="Answers naming you"
          className="max-w-none"
          data={points}
          segments={keys.map(engineLabel)}
          periods={PERIODS}
          defaultPeriod={openingPeriod(points)}
          breakdownNote="Average per scan, by engine. An answer can name you on several engines, so these do not add up."
        />
      ) : (
        <EmptyCard title="Answers naming you">
          No scan in the last 90 days counted answers that name you.
        </EmptyCard>
      )}
      {hasEngines ? (
        <UptimeCard title="Answer engines" className="max-w-none" services={rows} endDate={endDate} />
      ) : (
        <EmptyCard title="Answer engines">
          No scan in the last 90 days recorded how each engine answered.
        </EmptyCard>
      )}
    </div>
  );
}
