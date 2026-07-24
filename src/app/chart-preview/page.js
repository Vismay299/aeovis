"use client";

/**
 * TEMPORARY DESIGN HARNESS — not a product route.
 *
 * Renders every src/components/perceev/charts/* component against
 * realistic sample data (the real /api/brands/[brand]/metrics response
 * shape) so the whole "Results Night" chart library can be verified in one
 * screenshot. Safe to delete once these components are wired into the real
 * dashboard pages.
 */

import { Donut, PerformanceMatrix, RankTable, TrendChart, DeltaChip } from "@/components/perceev/charts";

const SELF_BRAND = "snitch.com";

// snitch.com's real trend from the live DB: 6.7% -> 3.4% over ~10 scans on
// a 72h cadence. Rival series are illustrative, shaped the same way.
const SELF_SERIES = [
  { date: "2026-06-01", visibility_pct: 6.7 },
  { date: "2026-06-04", visibility_pct: 6.1 },
  { date: "2026-06-07", visibility_pct: 6.4 },
  { date: "2026-06-10", visibility_pct: 5.5 },
  { date: "2026-06-13", visibility_pct: 5.8 },
  { date: "2026-06-16", visibility_pct: 4.9 },
  { date: "2026-06-19", visibility_pct: 4.2 },
  { date: "2026-06-22", visibility_pct: 4.4 },
  { date: "2026-06-25", visibility_pct: 3.8 },
  { date: "2026-06-28", visibility_pct: 3.4 },
];

const RIVAL_ALPHA_SERIES = [
  { date: "2026-06-01", visibility_pct: 14.8 },
  { date: "2026-06-04", visibility_pct: 15.6 },
  { date: "2026-06-07", visibility_pct: 15.1 },
  { date: "2026-06-10", visibility_pct: 16.4 },
  { date: "2026-06-13", visibility_pct: 16.9 },
  { date: "2026-06-16", visibility_pct: 17.5 },
  { date: "2026-06-19", visibility_pct: 17.2 },
  { date: "2026-06-22", visibility_pct: 17.9 },
  { date: "2026-06-25", visibility_pct: 18.0 },
  { date: "2026-06-28", visibility_pct: 18.2 },
];

const RIVAL_BETA_SERIES = [
  { date: "2026-06-01", visibility_pct: 11.9 },
  { date: "2026-06-04", visibility_pct: 12.4 },
  { date: "2026-06-07", visibility_pct: 11.6 },
  { date: "2026-06-10", visibility_pct: 12.9 },
  { date: "2026-06-13", visibility_pct: null }, // a real missed-scan gap
  { date: "2026-06-16", visibility_pct: 13.0 },
  { date: "2026-06-19", visibility_pct: 12.7 },
  { date: "2026-06-22", visibility_pct: 12.3 },
  { date: "2026-06-25", visibility_pct: 12.6 },
  { date: "2026-06-28", visibility_pct: 12.5 },
];

// A newer entrant — only reports in from the second half of the window.
const RIVAL_GAMMA_SERIES = [
  { date: "2026-06-13", visibility_pct: 1.6 },
  { date: "2026-06-16", visibility_pct: 1.8 },
  { date: "2026-06-19", visibility_pct: 1.9 },
  { date: "2026-06-22", visibility_pct: 2.0 },
  { date: "2026-06-25", visibility_pct: 1.9 },
  { date: "2026-06-28", visibility_pct: 2.1 },
];

const RANK_ROWS = [
  { name: "rival-alpha.com", value: 18.2, delta: 1.4 },
  { name: "rival-beta.com", value: 12.5, delta: -0.6 },
  { name: "snitch.com", value: 3.4, delta: -0.4, isSelf: true },
  { name: "rival-gamma.com", value: 2.1, delta: 0.2 },
  { name: "rival-delta.com", value: 1.5, delta: null },
];

const MATRIX_BRANDS = ["snitch.com", "rival-alpha.com", "rival-beta.com", "rival-gamma.com"];
const MATRIX_ENGINES = ["aio", "perplexity"];
const MATRIX_VALUES = {
  "snitch.com": { aio: 3.4, perplexity: 2.1 },
  "rival-alpha.com": { aio: 18.2, perplexity: 14.6 },
  "rival-beta.com": { aio: 12.5, perplexity: 9.8 },
  "rival-gamma.com": { aio: 2.1, perplexity: null }, // no Perplexity coverage yet
};

const SOV_SEGMENTS = [
  { name: "rival-alpha.com", value: 18.2 },
  { name: "rival-beta.com", value: 12.5 },
  { name: "snitch.com", value: 3.4, isSelf: true },
  { name: "rival-gamma.com", value: 2.1 },
];

const Strap = ({ children }) => (
  <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginBottom: "var(--space-4)" }}>
    <span style={{ width: "3px", height: "14px", background: "var(--accent)", flexShrink: 0 }} />
    <span
      style={{
        fontFamily: "var(--font-display)",
        fontWeight: 700,
        fontSize: "13px",
        textTransform: "uppercase",
        letterSpacing: "0.12em",
        color: "var(--text-1)",
      }}
    >
      {children}
    </span>
  </div>
);

const LabeledChip = ({ label, children }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: "8px", alignItems: "flex-start" }}>
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "9px",
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        color: "var(--text-3)",
      }}
    >
      {label}
    </span>
    {children}
  </div>
);

export default function ChartPreviewPage() {
  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-0)", padding: "var(--space-8)" }}>
      <div style={{ maxWidth: "1200px", margin: "0 auto", display: "flex", flexDirection: "column", gap: "var(--space-9)" }}>
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "var(--space-4)",
            paddingBottom: "var(--space-5)",
            borderBottom: "1px solid var(--border-1)",
          }}
        >
          <div>
            <h1
              style={{
                fontFamily: "var(--font-display)",
                fontWeight: 700,
                fontSize: "28px",
                color: "var(--text-1)",
                letterSpacing: "var(--track-h1)",
              }}
            >
              Results Night — Chart Library
            </h1>
            <p style={{ marginTop: "4px", fontFamily: "var(--font-sans)", fontSize: "13px", color: "var(--text-3)" }}>
              src/components/perceev/charts — design harness, not a product route
            </p>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              padding: "5px 10px",
              border: "1px solid var(--border-2)",
              borderRadius: "var(--radius-1)",
            }}
          >
            <span style={{ width: "7px", height: "7px", borderRadius: "var(--radius-round)", background: "var(--rival)" }} />
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "10px",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                color: "var(--text-2)",
              }}
            >
              Simulated data
            </span>
          </div>
        </header>

        <section>
          <Strap>Visibility Trend</Strap>
          <TrendChart
            series={SELF_SERIES}
            compareSeries={[
              { name: "rival-alpha.com", series: RIVAL_ALPHA_SERIES },
              { name: "rival-beta.com", series: RIVAL_BETA_SERIES },
              { name: "rival-gamma.com", series: RIVAL_GAMMA_SERIES },
            ]}
            threshold={5}
            keyline="you"
          />
        </section>

        <section
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(320px, 1.3fr) minmax(280px, 1fr)",
            gap: "var(--space-6)",
            alignItems: "start",
          }}
        >
          <div>
            <Strap>Visibility Rank</Strap>
            <RankTable rows={RANK_ROWS} />
          </div>
          <div>
            <Strap>Share of Voice</Strap>
            <Donut segments={SOV_SEGMENTS} centerLabel="Snitch.com share" keyline="accent" />
          </div>
        </section>

        <section>
          <Strap>Engine Performance Matrix</Strap>
          <PerformanceMatrix
            brands={MATRIX_BRANDS}
            engines={MATRIX_ENGINES}
            values={MATRIX_VALUES}
            selfBrand={SELF_BRAND}
          />
        </section>

        <section>
          <Strap>Delta Chip — every state</Strap>
          <div
            style={{
              display: "flex",
              gap: "var(--space-7)",
              padding: "var(--space-5) var(--space-6)",
              background: "var(--bg-1)",
              border: "1px solid var(--border-1)",
              borderRadius: "var(--radius-2)",
            }}
          >
            <LabeledChip label="Positive">
              <DeltaChip value={3.4} />
            </LabeledChip>
            <LabeledChip label="Negative">
              <DeltaChip value={-1.2} />
            </LabeledChip>
            <LabeledChip label="Zero">
              <DeltaChip value={0} />
            </LabeledChip>
            <LabeledChip label="No data">
              <DeltaChip value={null} />
            </LabeledChip>
          </div>
        </section>
      </div>
    </div>
  );
}
