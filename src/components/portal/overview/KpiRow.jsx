"use client";

/** Four headline numbers. Unknown values render as an em dash, never 0. */

import Link from "next/link";
import { Eye, MessageSquareText, Search, Sparkles } from "lucide-react";
import { Skeleton, Stat } from "../ui";
import { countText, roundedPct, shortDate, toNumber } from "./overviewModel";
import "./overview.css";

function visibilitySub(scans, latest) {
  if (!latest) return "No scan yet";
  const previous = scans[1];
  const current = toNumber(latest.visibility_pct);
  const before = toNumber(previous?.visibility_pct);
  if (!previous || before === null || current === null) return "First scan";
  const delta = Math.round(current - before);
  const since = `since ${shortDate(previous.scanned_at || previous.created_at)}`;
  if (delta === 0) return `No change ${since}`;
  return `${delta > 0 ? "+" : "−"}${Math.abs(delta)} pts ${since}`;
}

export default function KpiRow({ overview, gsc }) {
  if (!overview) {
    return (
      <div className="pv-grid pv-grid--4 pv-overview-kpis" aria-busy="true" aria-label="Loading headline numbers">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="pv-card pv-overview-kpi-skeleton">
            <Skeleton width="45%" height={11} />
            <Skeleton width="35%" height={26} />
            <Skeleton width="60%" height={10} />
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

  return (
    <div className="pv-grid pv-grid--4 pv-overview-kpis">
      <Stat
        label="AI visibility"
        icon={Eye}
        value={roundedPct(latest?.visibility_pct)}
        suffix={roundedPct(latest?.visibility_pct) === null ? undefined : "%"}
        sub={visibilitySub(scans, latest)}
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
      <Link href="/portal/search-console" className="pv-overview-kpi-link">
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
