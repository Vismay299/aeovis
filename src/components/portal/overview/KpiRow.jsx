"use client";

/** Four headline numbers. Unknown values render as an em dash, never 0. */

import Link from "next/link";
import { Eye, MessageSquareText, Search, Sparkles } from "lucide-react";
import { Skeleton, Stat } from "../ui";
import { countText, roundedPct, shortDate, toNumber } from "./overviewModel";

function visibilityChange(scans, latest) {
  if (!latest) return { delta: undefined, sub: "No scan yet" };
  const previous = scans[1];
  const current = toNumber(latest.visibility_pct);
  const before = toNumber(previous?.visibility_pct);
  if (!previous || before === null || current === null) return { delta: undefined, sub: "First scan" };
  const change = Math.round(current - before);
  const since = `since ${shortDate(previous.scanned_at || previous.created_at)}`;
  if (change === 0) return { delta: { text: "No change", direction: "flat" }, sub: since };
  return {
    delta: {
      text: `${change > 0 ? "+" : "−"}${Math.abs(change)} pts`,
      direction: change > 0 ? "up" : "down",
    },
    sub: since,
  };
}

/**
 * Visibility per scan, oldest first, for the spark tile. Gaps are dropped
 * rather than drawn as zero, and fewer than two real points draw no spark.
 */
function visibilitySeries(scans) {
  const points = scans
    .slice()
    .reverse()
    .map((scan) => toNumber(scan.visibility_pct))
    .filter((value) => value !== null);
  return points.length >= 2 ? points : undefined;
}

export default function KpiRow({ overview, gsc }) {
  if (!overview) {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-busy="true" aria-label="Loading headline numbers">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex flex-col gap-2.5 rounded-lg border border-border bg-card p-4">
            <Skeleton width="45%" height={12} />
            <Skeleton width="35%" height={28} />
            <Skeleton width="60%" height={12} />
          </div>
        ))}
      </div>
    );
  }

  const scans = overview.scans || [];
  const latest = overview.latest_scan || null;
  const tracked = latest ? latest.prompts_tracked : null;
  const mentioned = latest ? latest.prompts_mentioned : null;
  const connected = gsc ? !!gsc.connected : null;
  const siteUrl = gsc?.connection?.site_url;
  const visibility = visibilityChange(scans, latest);

  return (
    <div className="stagger-children grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat
        label="AI visibility"
        icon={Eye}
        value={roundedPct(latest?.visibility_pct)}
        suffix={roundedPct(latest?.visibility_pct) === null ? undefined : "%"}
        sub={visibility.sub}
        delta={visibility.delta}
        series={visibilitySeries(scans)}
      />
      <Stat
        label="Questions tracked"
        icon={MessageSquareText}
        value={toNumber(tracked) === null ? null : countText(tracked)}
        sub={latest ? "In your latest scan" : "No scan yet"}
      />
      <Stat
        label="Answers naming you"
        icon={Sparkles}
        value={toNumber(mentioned) === null ? null : countText(mentioned)}
        sub={toNumber(tracked) === null ? "No scan yet" : `of ${countText(tracked)} questions`}
      />
      <Link href="/portal/search-console" className="block rounded-lg transition-colors hover:border-foreground/20 focus-visible:outline-2 focus-visible:outline-primary">
        <Stat
          label="Search Console"
          icon={Search}
          value={connected === null ? null : connected ? "Connected" : "Not connected"}
          sub={connected ? siteUrl || "Connected" : "Connect to import search data"}
        />
      </Link>
    </div>
  );
}
