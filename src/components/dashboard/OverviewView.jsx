import { KpiCard } from "@/components/perceev/KpiCard";
import { Card } from "@/components/perceev/Card";
import { Badge } from "@/components/perceev/Badge";
import { ArrowRight } from "lucide-react";
import { OverviewAnalytics } from "./OverviewAnalytics";

export const OverviewView = ({
  result,
  dataSourceIssue,
  onTabChange,
  heroScore,
  aioCoverage,
  nonBrandedWithAio,
  promptsTracked,
  presenceRate,
  visibleCount,
  competitorsFound,
  promptsAnalyzed,
  mentionedNonBrandedCount,
  citedNonBrandedCount,
  interpretation,
  tier,
}) => {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
      {/* Overview v2 (P1.4) — real analytics: The Verdict, Visibility Trend,
          Rank + Share of Voice. Sits above the pre-existing KPI/insight
          content below, which stays untouched. */}
      <OverviewAnalytics result={result} heroScore={heroScore} />

      {/* KPI cards 2×2 */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, 1fr)",
          gap: "var(--space-5)",
        }}
      >
        <KpiCard
          testId="kpi-aio-coverage"
          label="AI Overview coverage"
          value={dataSourceIssue ? "—" : (aioCoverage ?? 0)}
          suffix="%"
          tone={
            dataSourceIssue
              ? "crit"
              : (aioCoverage ?? 0) < 30
              ? "warn"
              : "good"
          }
          sub={`${nonBrandedWithAio ?? 0} of ${promptsTracked ?? 0} prompts`}
        />
        <KpiCard
          testId="kpi-presence"
          label="Presence"
          value={dataSourceIssue ? "—" : (presenceRate ?? 0)}
          suffix="%"
          sub={`${visibleCount ?? 0} of ${promptsTracked ?? 0} prompts`}
        />
        <KpiCard
          testId="kpi-prompts"
          label="Tracked Queries"
          value={promptsTracked ?? promptsAnalyzed ?? 0}
          sub="unbranded queries probed"
        />
        <KpiCard
          testId="kpi-competitors"
          label="Competitors Found"
          value={competitorsFound ?? 0}
          sub={
            (competitorsFound ?? 0) === 0
              ? "None co-mentioned in AIOs"
              : "Auto-found in AI Overviews"
          }
        />
      </div>

      {/* Where you're losing + What this means */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, 1fr)",
          gap: "var(--space-5)",
        }}
      >
        <Card
          style={{
            cursor: "pointer",
            transition: "border-color var(--dur-fast)",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--accent-border)")}
          onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--border-1)")}
        >
          <button
            onClick={() => onTabChange?.("answers")}
            data-testid="where-losing-card"
            style={{
              width: "100%",
              textAlign: "left",
              background: "none",
              border: "none",
              padding: 0,
              cursor: "pointer",
              fontFamily: "inherit",
              color: "inherit",
            }}
          >
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "10px",
                fontWeight: 500,
                textTransform: "uppercase",
                letterSpacing: "0.12em",
                color: "var(--crit)",
                marginBottom: "var(--space-2)",
              }}
            >
              Where you&apos;re losing
            </div>
            <h3
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: "17px",
                fontWeight: 600,
                color: "var(--text-1)",
                marginBottom: "var(--space-2)",
              }}
            >
              AI mentions you in {mentionedNonBrandedCount ?? 0} of{" "}
              {nonBrandedWithAio ?? 0} AI Overviews
            </h3>
            <p
              style={{
                fontSize: "13px",
                color: "var(--text-2)",
                lineHeight: 1.5,
                marginBottom: "var(--space-3)",
              }}
            >
              Dig into the exact AI Overviews where you appear — and where you
              don&apos;t.
            </p>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                fontFamily: "var(--font-mono)",
                fontSize: "10px",
                fontWeight: 500,
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                color: "var(--accent-text)",
              }}
            >
              View answers <ArrowRight size={12} />
            </span>
          </button>
        </Card>

        <Card>
          <div
            data-testid="insight-panel"
          >
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "10px",
                fontWeight: 500,
                textTransform: "uppercase",
                letterSpacing: "0.12em",
                color: "var(--text-3)",
                marginBottom: "var(--space-2)",
              }}
            >
              Summary Insights
            </div>
            <h3
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: "17px",
                fontWeight: 600,
                color: "var(--text-1)",
                marginBottom: "var(--space-3)",
              }}
            >
              What this means
            </h3>
            {tier && (
              <div style={{ marginBottom: "var(--space-3)" }}>
                <Badge variant={tier === "strong" ? "strong" : tier === "moderate" ? "moderate" : "weak"}>
                  {tier === "strong" ? "Strong" : tier === "moderate" ? "Moderate" : "Weak"} at{" "}
                  {heroScore ?? result.visibilityScore}/100
                </Badge>
              </div>
            )}
            <p
              data-testid="insight-interpretation"
              style={{
                fontSize: "14px",
                color: "var(--text-1)",
                lineHeight: 1.55,
              }}
            >
              {interpretation}
            </p>
            {result.summary && (
              <p
                style={{
                  fontSize: "14px",
                  color: "var(--text-2)",
                  lineHeight: 1.55,
                  borderLeft: "2px solid var(--accent)",
                  paddingLeft: "var(--space-4)",
                  marginTop: "var(--space-4)",
                  fontStyle: "italic",
                }}
              >
                {result.summary}
              </p>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
};
