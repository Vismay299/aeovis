import { Card } from "@/components/perceev/Card";
import { KpiCard } from "@/components/perceev/KpiCard";
import { Badge } from "@/components/perceev/Badge";
import { Globe, Link as LinkIcon } from "lucide-react";

export const SourcesView = ({ result }) => {
  const topDomains = result.topDomains || [];
  const totalCitations = (result.rawResults || []).reduce(
    (sum, r) => sum + ((r.aio_citations || r.aio_references || []).length),
    0
  );

  if (totalCitations === 0 && topDomains.length === 0) {
    return (
      <Card>
        <p style={{ textAlign: "center", fontSize: "13px", color: "var(--text-3)" }}>
          No AI Overview citations were captured in this scan.
        </p>
      </Card>
    );
  }

  return (
    <div data-testid="citations-panel" style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, 1fr)",
          gap: "var(--space-5)",
        }}
      >
        <KpiCard
          label="Total citations"
          value={totalCitations}
          sub="URLs referenced across all AI Overviews"
        />
        <KpiCard
          label="Your domain share"
          value={result.brandCitationSharePct ?? 0}
          suffix="%"
          sub="of non-branded queries where the AIO cites your domain"
        />
      </div>

      <Card>
        <div
          style={{
            paddingBottom: "var(--space-5)",
            borderBottom: "1px solid var(--border-1)",
            marginBottom: "var(--space-4)",
          }}
        >
          <h3
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "var(--type-h3)",
              fontWeight: 600,
              color: "var(--text-1)",
              letterSpacing: "var(--track-h3)",
            }}
          >
            Top cited domains
          </h3>
          <p style={{ fontSize: "13px", color: "var(--text-2)", marginTop: "4px" }}>
            Domains Google&apos;s AI Overview reaches for when answering your category queries.
          </p>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          {topDomains.map((item, i) => (
            <div
              key={item.domain}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "var(--space-4) 0",
                borderBottom: i < topDomains.length - 1 ? "1px solid var(--border-1)" : "none",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "12px",
                    color: "var(--text-3)",
                    width: "16px",
                  }}
                >
                  {i + 1}
                </span>
                <span
                  style={{
                    fontWeight: 600,
                    fontSize: "14px",
                    color:
                      item.type === "brand"
                        ? "var(--good)"
                        : item.type === "competitor"
                        ? "var(--crit)"
                        : "var(--text-1)",
                  }}
                >
                  {item.domain}
                </span>
                {item.type === "brand" && <Badge variant="strong">Own Domain</Badge>}
                {item.type === "competitor" && <Badge variant="weak">Competitor</Badge>}
              </div>
              <div style={{ fontSize: "13px", color: "var(--text-2)" }}>
                <span style={{ fontWeight: 600, color: "var(--text-1)" }}>{item.count}</span>{" "}
                citation{item.count === 1 ? "" : "s"}
              </div>
            </div>
          ))}
          {topDomains.length === 0 && (
            <div style={{ padding: "var(--space-8)", textAlign: "center", fontSize: "13px", color: "var(--text-3)" }}>
              No domain data yet.
            </div>
          )}
        </div>
      </Card>
    </div>
  );
};
