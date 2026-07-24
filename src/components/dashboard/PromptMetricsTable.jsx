"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import { Card } from "@/components/perceev/Card";
import { Badge } from "@/components/perceev/Badge";
import { Alert } from "@/components/perceev/Alert";
import { Skeleton } from "@/components/perceev/Skeleton";
import { DeltaChip } from "@/components/perceev/charts";
import { isFiniteNumber, formatPercent, roundTo } from "@/components/perceev/charts/chartMath";
import { SectionStrap } from "./SectionStrap";

/**
 * P2a — the dense per-prompt metrics table (Peec AI's "Prompts" view
 * successor to QueryManager's CRUD-only list). Fetches
 * GET /api/brands/[brand]/prompts/metrics (no `scan` param — always the
 * brand's latest scan) and renders one sortable/filterable row per tracked
 * prompt. Purely presentational over that one fetch: all grouping/delta/
 * null-handling math already happened server-side in
 * src/lib/analytics/promptMetrics.js's groupPromptRows.
 *
 * `brand` is ALREADY a resolveBrandKey() output by the time it reaches this
 * component — QueriesView (this component's only caller) receives it
 * pre-resolved from DashboardShell as
 * `resolveBrandKey(result.brand, result.website)` (see DashboardShell.jsx's
 * `view === "queries"` branch) and passes it straight through, so there is
 * no raw `{brand, website}` pair to re-resolve here.
 */

const INTENT_LABELS = {
  high_intent: "High Intent",
  comparison: "Comparison",
  problem_aware: "Problem Aware",
  exploratory: "Exploratory",
  branded: "Branded",
  informational: "Informational",
  commercial: "Commercial",
  transactional: "Transactional",
  navigational: "Navigational",
};

function intentLabel(intent) {
  if (!intent) return "Unspecified";
  return INTENT_LABELS[intent] || intent.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const ENGINE_SHORT = { aio: "AIO", chatgpt: "GPT", perplexity: "PPX" };

function engineShortLabel(engine) {
  return ENGINE_SHORT[engine] || String(engine || "").slice(0, 3).toUpperCase();
}

const BRANDED_LABELS = { branded: "Branded", non_branded: "Non-branded" };

/** good/warn/crit are semantic status tokens (not the you/rival party colors) — safe for a plain magnitude band on your OWN prompt's sentiment. */
function sentimentTone(value) {
  if (!isFiniteNumber(value)) return "var(--text-3)";
  if (value >= 67) return "var(--good)";
  if (value >= 34) return "var(--warn)";
  return "var(--crit)";
}

function sortValue(row, key) {
  switch (key) {
    case "prompt":
      return (row.query || "").toLowerCase();
    case "visibility":
      return row.answered_count === 0 ? null : row.visibility_pct;
    case "sentiment":
      return row.sentiment_avg;
    case "position":
      return row.position_avg;
    case "engines":
      return row.engines.length;
    case "intent":
      return intentLabel(row.intent).toLowerCase();
    case "type":
      return row.is_branded_query ? 1 : 0;
    default:
      return null;
  }
}

/** Rows with a null sort value always sort to the bottom, regardless of direction — a missing measurement is never "lowest" or "highest". */
function compareRows(a, b, key, dir) {
  const av = sortValue(a, key);
  const bv = sortValue(b, key);
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  if (typeof av === "string") return dir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
  return dir === "asc" ? av - bv : bv - av;
}

const GRID_COLUMNS = "minmax(220px, 2.2fr) 1.1fr 0.8fr 0.85fr 1.3fr 1.1fr 1fr";

function FilterPill({ active, onClick, children, testId }) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      style={{
        padding: "5px 12px",
        borderRadius: "var(--radius-round)",
        border: active ? "1px solid var(--accent-border)" : "1px solid var(--border-2)",
        background: active ? "var(--accent-soft)" : "transparent",
        color: active ? "var(--accent-text)" : "var(--text-2)",
        fontFamily: "var(--font-mono)",
        fontSize: "10px",
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        cursor: "pointer",
        transition: "all var(--dur-fast) var(--ease-out)",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

function SortableHeader({ label, columnKey, sortKey, sortDir, onSort, align = "left" }) {
  const active = sortKey === columnKey;
  return (
    <button
      type="button"
      onClick={() => onSort(columnKey)}
      data-testid={`prompt-metrics-sort-${columnKey}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "4px",
        justifyContent: align === "right" ? "flex-end" : "flex-start",
        width: "100%",
        background: "none",
        border: "none",
        padding: 0,
        cursor: "pointer",
        fontFamily: "var(--font-mono)",
        fontSize: "9px",
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        color: active ? "var(--text-1)" : "var(--text-3)",
      }}
    >
      {label}
      {/* CSS/vector icons, not a unicode glyph — same "no icon font/glyph
          fallback risk" reasoning as DeltaChip's own CSS-drawn triangle. */}
      <span style={{ display: "inline-flex", opacity: active ? 1 : 0.35, flexShrink: 0 }}>
        {active && sortDir === "asc" ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
      </span>
    </button>
  );
}

function EngineChips({ breakdown }) {
  const list = Array.isArray(breakdown) ? breakdown : [];
  if (list.length === 0) {
    return <span style={{ fontSize: "11px", color: "var(--text-3)" }}>—</span>;
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
      {list.map((e) => {
        const tone = e.mentioned
          ? { bg: "var(--you-soft)", color: "var(--you)", border: "var(--you-border)" }
          : e.answered
          ? { bg: "var(--bg-2)", color: "var(--text-2)", border: "var(--border-2)" }
          : { bg: "transparent", color: "var(--text-3)", border: "var(--border-1)" };
        const title = e.mentioned
          ? `${e.engine}: mentioned`
          : e.answered
          ? `${e.engine}: answered, brand not mentioned`
          : `${e.engine}: no answer this scan`;
        return (
          <span
            key={e.engine}
            title={title}
            data-testid={`prompt-metrics-engine-${e.engine}`}
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "9px",
              fontWeight: 600,
              letterSpacing: "0.04em",
              padding: "2px 5px",
              borderRadius: "var(--radius-1)",
              background: tone.bg,
              color: tone.color,
              border: `1px solid ${tone.border}`,
            }}
          >
            {engineShortLabel(e.engine)}
          </span>
        );
      })}
    </div>
  );
}

const labelStyle = {
  fontFamily: "var(--font-mono)",
  fontSize: "10px",
  color: "var(--text-3)",
  marginRight: "2px",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
};

export const PromptMetricsTable = ({ brand }) => {
  const [data, setData] = useState(undefined); // undefined = loading, null = fatal error, object = ready
  const [errorMessage, setErrorMessage] = useState(null);
  const [intentFilter, setIntentFilter] = useState("all");
  const [brandedFilter, setBrandedFilter] = useState("all");
  const [sortKey, setSortKey] = useState("visibility");
  const [sortDir, setSortDir] = useState("desc");

  const fetchMetrics = useCallback(async () => {
    if (!brand) {
      setData(null);
      setErrorMessage("No brand key available yet.");
      return;
    }
    setData(undefined);
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/brands/${encodeURIComponent(brand)}/prompts/metrics`, { cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setData(null);
        setErrorMessage(json?.error || "Failed to load prompt metrics.");
        return;
      }
      setData(json);
    } catch {
      setData(null);
      setErrorMessage("Network error while loading prompt metrics. Check your connection and retry.");
    }
  }, [brand]);

  useEffect(() => {
    fetchMetrics();
  }, [fetchMetrics]);

  const allRows = useMemo(() => (data && Array.isArray(data.prompts) ? data.prompts : []), [data]);

  const intentOptions = useMemo(() => {
    const set = new Set();
    allRows.forEach((r) => set.add(r.intent || "__none__"));
    return Array.from(set).sort();
  }, [allRows]);

  const filteredRows = useMemo(() => {
    return allRows.filter((r) => {
      if (intentFilter !== "all" && (r.intent || "__none__") !== intentFilter) return false;
      if (brandedFilter === "branded" && !r.is_branded_query) return false;
      if (brandedFilter === "non_branded" && r.is_branded_query) return false;
      return true;
    });
  }, [allRows, intentFilter, brandedFilter]);

  const sortedRows = useMemo(
    () => [...filteredRows].sort((a, b) => compareRows(a, b, sortKey, sortDir)),
    [filteredRows, sortKey, sortDir]
  );

  const handleSort = (key) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "prompt" || key === "intent" || key === "type" ? "asc" : "desc");
    }
  };

  return (
    <div
      data-testid="prompt-metrics-table"
      style={{ padding: "var(--space-6) var(--space-6) var(--space-2)", display: "flex", flexDirection: "column", gap: "var(--space-4)" }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: "var(--space-3)" }}>
        <SectionStrap testId="prompt-metrics-strap">Prompt performance</SectionStrap>
        {data && allRows.length > 0 && (
          <span
            title="Older scans never computed sentiment/position — those cells stay — instead of guessing 0 until a fresh scan measures them."
            style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "var(--text-3)" }}
          >
            — = not yet measured, populates from your next scan
          </span>
        )}
      </div>

      {/* Loading */}
      {data === undefined && (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          <Skeleton style={{ height: "32px", borderRadius: "var(--radius-1)", width: "280px" }} />
          <Skeleton style={{ height: "240px", borderRadius: "var(--radius-2)" }} />
        </div>
      )}

      {/* Fatal error */}
      {data === null && (
        <Alert
          data-testid="prompt-metrics-error"
          variant="crit"
          title={
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
              <AlertCircle size={16} />
              Couldn&apos;t load prompt metrics
            </div>
          }
          action={
            brand ? (
              <button
                type="button"
                onClick={fetchMetrics}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  background: "transparent",
                  border: "1px solid var(--crit-border)",
                  color: "var(--crit)",
                  borderRadius: "var(--radius-1)",
                  padding: "6px 12px",
                  fontFamily: "var(--font-mono)",
                  fontSize: "10px",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  cursor: "pointer",
                }}
              >
                <RefreshCw size={12} />
                Retry
              </button>
            ) : undefined
          }
        >
          {errorMessage || "Something went wrong while loading prompt metrics."}
        </Alert>
      )}

      {/* Ready */}
      {data && (
        <>
          {allRows.length === 0 ? (
            <div
              data-testid="prompt-metrics-empty"
              style={{
                background: "var(--bg-1)",
                border: "1px solid var(--border-1)",
                borderRadius: "var(--radius-2)",
                padding: "var(--space-8) var(--space-7)",
                textAlign: "center",
                fontSize: "13px",
                color: "var(--text-3)",
                lineHeight: 1.6,
              }}
            >
              No prompt data yet — run a scan to populate this table.
            </div>
          ) : (
            <>
              {/* Filters */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-5)", alignItems: "center" }}>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px" }}>
                  <span style={labelStyle}>Intent</span>
                  <FilterPill testId="prompt-metrics-filter-intent-all" active={intentFilter === "all"} onClick={() => setIntentFilter("all")}>
                    All
                  </FilterPill>
                  {intentOptions.map((opt) => (
                    <FilterPill
                      key={opt}
                      testId={`prompt-metrics-filter-intent-${opt}`}
                      active={intentFilter === opt}
                      onClick={() => setIntentFilter(opt)}
                    >
                      {intentLabel(opt === "__none__" ? null : opt)}
                    </FilterPill>
                  ))}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <span style={labelStyle}>Type</span>
                  {["all", "branded", "non_branded"].map((opt) => (
                    <FilterPill
                      key={opt}
                      testId={`prompt-metrics-filter-type-${opt}`}
                      active={brandedFilter === opt}
                      onClick={() => setBrandedFilter(opt)}
                    >
                      {opt === "all" ? "All" : BRANDED_LABELS[opt]}
                    </FilterPill>
                  ))}
                </div>
              </div>

              {/* Table */}
              <Card variant="flush" style={{ overflowX: "auto" }}>
                <div style={{ minWidth: "800px" }}>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: GRID_COLUMNS,
                      gap: "var(--space-3)",
                      padding: "var(--space-3) var(--space-5)",
                      borderBottom: "1px solid var(--border-1)",
                    }}
                  >
                    <SortableHeader label="Prompt" columnKey="prompt" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                    <SortableHeader label="Visibility" columnKey="visibility" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                    <SortableHeader label="Sentiment" columnKey="sentiment" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                    <SortableHeader label="Position" columnKey="position" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                    <SortableHeader label="Engines" columnKey="engines" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                    <SortableHeader label="Intent" columnKey="intent" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                    <SortableHeader label="Type" columnKey="type" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                  </div>

                  {sortedRows.length === 0 ? (
                    <div style={{ padding: "var(--space-7)", textAlign: "center", fontSize: "13px", color: "var(--text-3)" }}>
                      No prompts match the current filters.
                    </div>
                  ) : (
                    sortedRows.map((row, i) => {
                      // The API reports visibility_pct: 0 (never null) when
                      // no engine answered this prompt at all, matching
                      // enginePipeline.js's own convention (see
                      // promptMetrics.js's computeVisibilityPct) — but a
                      // bare "0%" would read as "we checked and you're
                      // absent" when the honest story is "nothing answered
                      // this prompt yet". This is the ONE place the UI
                      // overrides a real API value with "—": every other
                      // dash on this row (sentiment/position) already comes
                      // straight from a null the API itself returned.
                      const noSignal = row.answered_count === 0;
                      return (
                        <div
                          key={row.query || i}
                          data-testid={`prompt-metrics-row-${i}`}
                          style={{
                            display: "grid",
                            gridTemplateColumns: GRID_COLUMNS,
                            gap: "var(--space-3)",
                            padding: "var(--space-3) var(--space-5)",
                            borderBottom: i < sortedRows.length - 1 ? "1px solid var(--border-1)" : "none",
                            alignItems: "center",
                          }}
                        >
                          <span
                            title={row.query}
                            style={{
                              fontSize: "13px",
                              color: "var(--text-1)",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {row.query}
                          </span>

                          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                            <span
                              data-testid={`prompt-metrics-row-${i}-visibility`}
                              style={{
                                fontFamily: "var(--font-display)",
                                fontWeight: 600,
                                fontSize: "14px",
                                fontVariantNumeric: "tabular-nums",
                                color: noSignal ? "var(--text-3)" : "var(--text-1)",
                              }}
                            >
                              {noSignal ? "—" : formatPercent(row.visibility_pct)}
                            </span>
                            <DeltaChip value={row.delta_visibility_pct} testId={`prompt-metrics-row-${i}-delta`} />
                          </div>

                          <span
                            title={isFiniteNumber(row.sentiment_avg) ? undefined : "Measured from your next scan"}
                            style={{
                              fontFamily: "var(--font-display)",
                              fontVariantNumeric: "tabular-nums",
                              fontSize: "13px",
                              fontWeight: 600,
                              color: sentimentTone(row.sentiment_avg),
                            }}
                          >
                            {isFiniteNumber(row.sentiment_avg) ? Math.round(row.sentiment_avg) : "—"}
                          </span>

                          <span
                            title={isFiniteNumber(row.position_avg) ? undefined : "Measured from your next scan"}
                            style={{
                              fontFamily: "var(--font-display)",
                              fontVariantNumeric: "tabular-nums",
                              fontSize: "13px",
                              color: isFiniteNumber(row.position_avg) ? "var(--text-1)" : "var(--text-3)",
                            }}
                          >
                            {isFiniteNumber(row.position_avg) ? `#${roundTo(row.position_avg, 1).toFixed(1)}` : "—"}
                          </span>

                          <EngineChips breakdown={row.engine_breakdown} />

                          <div>
                            <Badge variant="neutral">{intentLabel(row.intent)}</Badge>
                          </div>

                          <div>
                            <Badge variant={row.is_branded_query ? "neutral" : "muted"}>
                              {row.is_branded_query ? "Branded" : "Non-branded"}
                            </Badge>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </Card>
            </>
          )}
        </>
      )}
    </div>
  );
};
