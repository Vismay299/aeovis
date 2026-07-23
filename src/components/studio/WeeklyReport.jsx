"use client";

import { useState } from "react";
import { Loader2, FileBarChart, TrendingUp, TrendingDown, Minus, ArrowRight } from "lucide-react";
import { Card } from "@/components/perceev/Card";
import { Badge } from "@/components/perceev/Badge";
import { Button } from "@/components/perceev/Button";

const monoLabel = {
  fontFamily: "var(--font-mono)",
  fontSize: "9px",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.1em",
  color: "var(--text-3)",
};

function Delta({ value }) {
  if (value == null) return <span style={{ fontSize: "11px", color: "var(--text-3)" }}>—</span>;
  const up = value > 0;
  const down = value < 0;
  const color = up ? "var(--good)" : down ? "var(--crit)" : "var(--text-3)";
  const Icon = up ? TrendingUp : down ? TrendingDown : Minus;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "3px", color, fontSize: "12px", fontWeight: 600 }}>
      <Icon size={12} />
      {up ? "+" : ""}
      {value}
    </span>
  );
}

/**
 * Weekly report — three KPIs with WoW deltas, per-engine visibility, and
 * exactly three prioritized actions. Generated on demand (one LLM call).
 */
export function WeeklyReport({ brand }) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const generate = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/content/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Failed to generate report");
      setReport(data.report);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }} data-testid="studio-report">
      {!report && (
        <Card style={{ padding: "var(--space-7)", textAlign: "center" }}>
          <FileBarChart size={28} style={{ color: "var(--accent)", margin: "0 auto var(--space-4)" }} />
          <h3 style={{ fontFamily: "var(--font-sans)", fontSize: "17px", fontWeight: 600, color: "var(--text-1)" }}>
            Weekly visibility report
          </h3>
          <p style={{ fontSize: "13px", color: "var(--text-2)", marginTop: "var(--space-2)", lineHeight: 1.6, maxWidth: "460px", margin: "var(--space-2) auto 0" }}>
            Three KPIs with week-over-week deltas, per-engine visibility, and exactly
            three prioritized actions — each backed by a number. Generated from your
            scan history and content activity.
          </p>
          <div style={{ marginTop: "var(--space-5)" }}>
            <Button variant="primary" size="md" onClick={generate} disabled={loading} data-testid="studio-report-generate">
              {loading ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <FileBarChart size={14} />}
              {loading ? "Generating…" : "Generate report"}
            </Button>
          </div>
          {error && <div style={{ fontSize: "12px", color: "var(--crit)", marginTop: "var(--space-3)" }}>{error}</div>}
        </Card>
      )}

      {report && (
        <>
          <Card style={{ padding: "var(--space-6)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "var(--space-4)" }}>
              <div>
                <div style={monoLabel}>Headline</div>
                <h3 style={{ fontFamily: "var(--font-sans)", fontSize: "18px", fontWeight: 600, color: "var(--text-1)", marginTop: "var(--space-2)", lineHeight: 1.35 }}>
                  {report.headline || "This week"}
                </h3>
                {report.summary && (
                  <p style={{ fontSize: "13px", color: "var(--text-2)", marginTop: "var(--space-3)", lineHeight: 1.6 }}>{report.summary}</p>
                )}
              </div>
              <Button variant="secondary" size="sm" onClick={generate} disabled={loading}>
                {loading ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> : "Refresh"}
              </Button>
            </div>
          </Card>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "var(--space-4)" }}>
            {report.kpis.map((k) => (
              <Card key={k.key} style={{ padding: "var(--space-5)" }}>
                <div style={monoLabel}>{k.label}</div>
                <div style={{ display: "flex", alignItems: "baseline", gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
                  <span style={{ fontFamily: "var(--font-sans)", fontSize: "26px", fontWeight: 600, color: "var(--text-1)" }}>
                    {k.value == null ? "—" : k.value}
                    {k.value != null && <span style={{ fontSize: "14px", color: "var(--text-3)" }}>{k.unit}</span>}
                  </span>
                </div>
                <div style={{ marginTop: "var(--space-2)" }}>
                  {report.has_previous ? <Delta value={k.delta} /> : <span style={{ fontSize: "11px", color: "var(--text-3)" }}>no prior scan</span>}
                  {report.has_previous && <span style={{ fontSize: "10px", color: "var(--text-3)", marginLeft: "6px" }}>WoW</span>}
                </div>
              </Card>
            ))}
          </div>

          {report.per_engine.length > 0 && (
            <Card style={{ padding: "var(--space-5)" }}>
              <div style={{ ...monoLabel, marginBottom: "var(--space-3)" }}>Per-engine visibility</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-5)" }}>
                {report.per_engine.map((e) => (
                  <div key={e.engine} style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                    <Badge variant="neutral">{e.engine === "aio" ? "AIO" : e.engine === "chatgpt" ? "ChatGPT" : e.engine === "perplexity" ? "PPLX" : e.engine}</Badge>
                    <span style={{ fontSize: "15px", fontWeight: 600, color: "var(--text-1)" }}>{e.value == null ? "—" : `${e.value}%`}</span>
                    {report.has_previous && <Delta value={e.delta} />}
                  </div>
                ))}
              </div>
            </Card>
          )}

          <div>
            <div style={{ ...monoLabel, marginBottom: "var(--space-3)" }}>The three priorities</div>
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
              {report.priorities.map((p, i) => (
                <Card key={i} style={{ padding: "var(--space-5)" }} data-testid="studio-priority">
                  <div style={{ display: "flex", gap: "var(--space-3)" }}>
                    <span
                      style={{
                        flexShrink: 0,
                        width: "24px",
                        height: "24px",
                        borderRadius: "50%",
                        background: "var(--accent-soft)",
                        color: "var(--accent-text)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontFamily: "var(--font-mono)",
                        fontSize: "12px",
                        fontWeight: 700,
                      }}
                    >
                      {i + 1}
                    </span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-1)" }}>{p.title}</div>
                      {p.why && <div style={{ fontSize: "12px", color: "var(--text-2)", marginTop: "4px" }}>{p.why}</div>}
                      {p.action && (
                        <div style={{ display: "flex", alignItems: "flex-start", gap: "6px", fontSize: "12px", color: "var(--accent-text)", marginTop: "var(--space-2)" }}>
                          <ArrowRight size={13} style={{ flexShrink: 0, marginTop: "2px" }} />
                          <span>{p.action}</span>
                        </div>
                      )}
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
