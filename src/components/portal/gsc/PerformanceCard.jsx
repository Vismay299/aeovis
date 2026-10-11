"use client";

/**
 * Search performance for the connected property: window totals plus the top
 * queries aggregated from the daily query rows returned by /api/customer/gsc/data.
 */

import { useEffect, useMemo, useState } from "react";
import { Eye, MousePointerClick, Percent, Hash, Search } from "lucide-react";
import { Banner, Card, EmptyState, SkeletonRows, Stat } from "../ui";

const WINDOW_DAYS = 28;
const ROW_LIMIT = 1000;
const TOP_QUERIES = 10;

const countFormat = new Intl.NumberFormat();

function topQueries(rows) {
  const byQuery = new Map();
  for (const row of rows) {
    const key = row.query || "";
    const entry = byQuery.get(key) || { query: key, clicks: 0, impressions: 0, positionWeight: 0, positionImpressions: 0 };
    const impressions = row.impressions || 0;
    entry.clicks += row.clicks || 0;
    entry.impressions += impressions;
    if (row.position > 0 && impressions > 0) {
      entry.positionWeight += row.position * impressions;
      entry.positionImpressions += impressions;
    }
    byQuery.set(key, entry);
  }
  return [...byQuery.values()]
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
    .slice(0, TOP_QUERIES)
    .map((entry) => ({
      query: entry.query,
      clicks: entry.clicks,
      impressions: entry.impressions,
      ctr: entry.impressions ? entry.clicks / entry.impressions : null,
      position: entry.positionImpressions ? entry.positionWeight / entry.positionImpressions : null,
    }));
}

export default function PerformanceCard({ brandKey, syncKey, redirectToLogin }) {
  const [state, setState] = useState({ loading: true, error: "", body: null });

  useEffect(() => {
    let live = true;
    setState((current) => ({ ...current, loading: true, error: "" }));
    fetch(`/api/customer/gsc/data?brand_key=${encodeURIComponent(brandKey)}&days=${WINDOW_DAYS}&limit=${ROW_LIMIT}`, { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 401) { redirectToLogin(); return null; }
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "Could not load search performance.");
        return body;
      })
      .then((body) => {
        if (live && body) setState({ loading: false, error: "", body });
      })
      .catch((failure) => {
        if (live) setState({ loading: false, error: failure.message || "Could not load search performance.", body: null });
      });
    return () => { live = false; };
  }, [brandKey, syncKey, redirectToLogin]);

  const rows = useMemo(() => state.body?.data || [], [state.body]);
  const queries = useMemo(() => topQueries(rows), [rows]);
  const totals = state.body?.totals || null;
  const hasData = rows.length > 0;

  const clicks = totals ? countFormat.format(totals.clicks || 0) : null;
  const impressions = totals ? countFormat.format(totals.impressions || 0) : null;
  const ctr = totals && typeof totals.ctr === "number" ? (totals.ctr * 100).toFixed(1) : null;
  const position = totals && typeof totals.avg_position === "number" ? totals.avg_position.toFixed(1) : null;

  return (
    <Card
      title="Search performance"
      description={`Last ${state.body?.days || WINDOW_DAYS} days of query data for this property.`}
      flush
      footer={hasData && totals?.note ? <p className="pv-hint pv-gsc-note">{totals.note}</p> : null}
    >
      {state.loading && !state.body ? (
        <div className="pv-gsc-perf__pad"><SkeletonRows rows={4} /></div>
      ) : state.error ? (
        <div className="pv-gsc-perf__pad"><Banner tone="error">{state.error}</Banner></div>
      ) : !hasData ? (
        <EmptyState icon={Search} title="No search data yet">
          Data arrives after the first daily sync.
        </EmptyState>
      ) : (
        <>
          <div className="pv-grid pv-grid--4 pv-gsc-perf__stats">
            <Stat label="Clicks" icon={MousePointerClick} value={clicks} />
            <Stat label="Impressions" icon={Eye} value={impressions} />
            <Stat label="CTR" icon={Percent} value={ctr} suffix={ctr === null ? undefined : "%"} />
            <Stat label="Avg. position" icon={Hash} value={position} />
          </div>
          <div className="pv-gsc-perf__table">
            <h3 className="pv-gsc-perf__heading">Top queries</h3>
            {queries.length ? (
              <div className="pv-table-wrap">
                <table className="pv-table">
                  <thead>
                    <tr>
                      <th scope="col">Query</th>
                      <th scope="col" className="pv-num">Clicks</th>
                      <th scope="col" className="pv-num">Impressions</th>
                      <th scope="col" className="pv-num">CTR</th>
                      <th scope="col" className="pv-num">Position</th>
                    </tr>
                  </thead>
                  <tbody>
                    {queries.map((item) => (
                      <tr key={item.query || "(anonymized)"}>
                        <td>{item.query || <span className="pv-muted">Anonymized queries</span>}</td>
                        <td className="pv-num">{countFormat.format(item.clicks)}</td>
                        <td className="pv-num">{countFormat.format(item.impressions)}</td>
                        <td className="pv-num">{item.ctr === null ? "—" : `${(item.ctr * 100).toFixed(1)}%`}</td>
                        <td className="pv-num">{item.position === null ? "—" : item.position.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        </>
      )}
    </Card>
  );
}
