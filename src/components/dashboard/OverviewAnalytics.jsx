"use client";

import { useEffect, useMemo, useState } from "react";
import { resolveBrandKey } from "@/shared/scoring/brandKey";
import { isFiniteNumber } from "@/components/perceev/charts/chartMath";
import { VisibilityVerdictPanel } from "./VisibilityVerdictPanel";
import { VisibilityTrendPanel } from "./VisibilityTrendPanel";
import { RankAndSharePanel } from "./RankAndSharePanel";

/**
 * Self + competitor rows for RankTable/Donut/the verdict sentence — built
 * ONCE here and threaded to all three so they can never disagree about who's
 * ranked where. `selfDelta` (real data from the /metrics summary, not
 * fabricated) enriches the self row once it's loaded; competitors stay
 * `delta: null` for now (per-rival history lands with symmetric judging) —
 * DeltaChip already renders null as muted, so this needs no extra branching.
 */
function buildRankedEntries(result, heroScore, selfDelta) {
  const selfValue = isFiniteNumber(heroScore)
    ? heroScore
    : isFiniteNumber(result?.shareOfAiPct)
    ? result.shareOfAiPct
    : 0;
  const selfEntry = { name: result?.brand || "Your brand", value: selfValue, isSelf: true, delta: selfDelta ?? null };

  const allCompetitors = Array.isArray(result?.competitors) ? result.competitors : [];
  // Mirrors RivalsView's own display rule: prefer competitors with real
  // signal, but don't leave the board down to just the self row when
  // discovery has only seeded names and nobody's been scored yet.
  const withSignal = allCompetitors.filter(
    (c) => (c.visibilityScore ?? 0) > 0 || (c.mentions ?? 0) > 0 || (c.citations ?? 0) > 0
  );
  const source = withSignal.length > 0 ? withSignal : allCompetitors;
  const competitorEntries = source.map((c) => ({
    name: c.name,
    value: isFiniteNumber(c.visibilityScore) ? c.visibilityScore : 0,
    isSelf: false,
    delta: null,
  }));

  return [selfEntry, ...competitorEntries].sort((a, b) => b.value - a.value);
}

/**
 * Overview v2 (P1.4) — the new analytics block at the top of Overview: The
 * Verdict, Visibility Trend, and the Rank/Share-of-Voice row. Owns the one
 * `/api/brands/[brand]/metrics` fetch the trend chart and the rank board's
 * self-delta both need; everything else here derives synchronously from the
 * already-loaded `result` (no fetch required) so the verdict and rank board
 * render immediately even while the trend fetch is still in flight.
 *
 * Brand-keying: the metrics endpoint is keyed by resolveBrandKey(brand, url)
 * — the DOMAIN, never the typed display name (src/shared/scoring/brandKey.js).
 *
 * @param {object} result normalized scan record (services/api.js normalizeResult output)
 * @param {number} heroScore this scan's headline visibility, as computed by DashboardShell
 */
export const OverviewAnalytics = ({ result, heroScore }) => {
  const brandKey = useMemo(
    () => (result ? resolveBrandKey(result.brand, result.website) : null),
    [result]
  );

  const [metrics, setMetrics] = useState({ status: "loading" });

  useEffect(() => {
    if (!brandKey) {
      setMetrics({ status: "error" });
      return;
    }

    let cancelled = false;
    setMetrics({ status: "loading" });

    fetch(`/api/brands/${encodeURIComponent(brandKey)}/metrics?engine=all`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`metrics HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        setMetrics({ status: "ready", series: data.series || [], summary: data.summary || null });
      })
      .catch((err) => {
        if (cancelled) return;
        // Never crash the Overview over a trend fetch — the rest of the
        // dashboard (and this block's verdict/rank rows) works fine without it.
        console.error("Failed to load brand metrics:", err);
        setMetrics({ status: "error" });
      });

    return () => {
      cancelled = true;
    };
  }, [brandKey]);

  const selfDelta = metrics.status === "ready" ? metrics.summary?.delta_visibility_pct ?? null : null;
  const rankedEntries = useMemo(
    () => buildRankedEntries(result, heroScore, selfDelta),
    [result, heroScore, selfDelta]
  );

  if (!result) return null;

  return (
    <div data-testid="overview-analytics" style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
      <VisibilityVerdictPanel result={result} rankedEntries={rankedEntries} />
      <VisibilityTrendPanel metrics={metrics} heroScore={heroScore} />
      <RankAndSharePanel result={result} rankedEntries={rankedEntries} />
    </div>
  );
};
