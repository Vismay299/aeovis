"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Target, Play, Link2, Radar } from "lucide-react";
import { Card } from "@/components/perceev/Card";
import { Badge } from "@/components/perceev/Badge";
import { Button } from "@/components/perceev/Button";

/** Heuristic: recommend a format from the shape of the query. */
function recommendFormat(query) {
  const q = String(query || "").toLowerCase();
  if (/\bvs\b|versus|compare|comparison|alternative/.test(q)) return "comparison";
  if (/\bbest\b|\btop\b|\d+\s|list|which/.test(q)) return "listicle";
  if (/how to|how do|steps|guide/.test(q)) return "how_to";
  if (/what is|what are|why|when|meaning|definition/.test(q)) return "faq";
  return "article";
}

/** Normalize scan rows to gap opportunities (brand present-but-uncited / absent). */
function gapsFromScan(scan) {
  const rows = scan?.raw_results?.results || scan?.results || scan?.rawResults || [];
  const byQuery = new Map();
  for (const r of rows) {
    const branded = r.is_branded_query ?? r.isBrandedQuery;
    const present = r.answer_present || r.aio_present || r.aioPresent;
    const cited = r.brand_cited ?? r.brandCited;
    const visible = r.visible;
    if (branded || !present || cited) continue;
    const query = r.prompt || r.text || "";
    if (!query) continue;
    const key = query.toLowerCase().trim();
    const engine = r.engine || "aio";
    const refs = r.references || r.aio_references || r.aioReferences || [];
    const domains = refs
      .map((x) => {
        try {
          return new URL(x.href).hostname.replace(/^www\./, "");
        } catch {
          return x.domain || null;
        }
      })
      .filter(Boolean);
    const entry = byQuery.get(key) || {
      query,
      engines: new Set(),
      rank_not_cited: false,
      domains: new Set(),
      topic: r.topic || "General",
      answer_text: r.text || r.aio_text || r.aioText || "",
    };
    entry.engines.add(engine);
    if (visible && !cited) entry.rank_not_cited = true;
    domains.forEach((d) => entry.domains.add(d));
    byQuery.set(key, entry);
  }
  return Array.from(byQuery.values()).map((e) => ({
    query: e.query,
    engines: Array.from(e.engines),
    rank_not_cited: e.rank_not_cited,
    domains: Array.from(e.domains).slice(0, 4),
    topic: e.topic,
    answer_text: e.answer_text,
    recommended: recommendFormat(e.query),
  }));
}

function GapCard({ gap, agents, onLaunch }) {
  // Prefer an agent whose format matches the recommendation, else first.
  const suggested =
    agents.find((a) => a.format === gap.recommended) || agents.find((a) => a.base === "geo_article") || agents[0];
  const [agentId, setAgentId] = useState(suggested?.id || "");
  const [launching, setLaunching] = useState(false);

  useEffect(() => {
    if (!agentId && suggested) setAgentId(suggested.id);
  }, [suggested, agentId]);

  const recAgent = agents.find((a) => a.format === gap.recommended);

  const launch = async () => {
    setLaunching(true);
    try {
      await onLaunch(gap, agentId);
    } finally {
      setLaunching(false);
    }
  };

  return (
    <Card style={{ padding: "var(--space-5)" }} data-testid="opportunity-card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "var(--space-3)" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-1)", lineHeight: 1.4 }}>{gap.query}</div>
          <div style={{ display: "flex", gap: "6px", marginTop: "var(--space-2)", flexWrap: "wrap", alignItems: "center" }}>
            <Badge variant={gap.rank_not_cited ? "moderate" : "weak"} dot>
              {gap.rank_not_cited ? "mentioned, not cited" : "absent"}
            </Badge>
            {gap.engines.map((e) => (
              <Badge key={e} variant="muted">{e === "aio" ? "AIO" : e === "chatgpt" ? "ChatGPT" : e === "perplexity" ? "PPLX" : e}</Badge>
            ))}
          </div>
        </div>
      </div>

      {gap.domains.length > 0 && (
        <div style={{ marginTop: "var(--space-3)", fontSize: "11px", color: "var(--text-2)" }}>
          <Link2 size={11} style={{ verticalAlign: "middle", marginRight: "4px", color: "var(--text-3)" }} />
          Winning sources: {gap.domains.join(", ")}
        </div>
      )}

      <div
        style={{
          marginTop: "var(--space-3)",
          padding: "var(--space-3)",
          background: "var(--accent-soft)",
          borderRadius: "var(--radius-1)",
          fontSize: "11px",
          color: "var(--accent-text)",
          display: "flex",
          alignItems: "center",
          gap: "6px",
        }}
      >
        <Target size={12} />
        Recommended format: <strong>{gap.recommended}</strong>
        {recAgent ? ` — the "${recAgent.name}" agent fits.` : " — build an agent for this format."}
      </div>

      <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-4)", alignItems: "center" }}>
        <select
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          data-testid="opportunity-agent"
          className="inp"
          aria-label="Agent for this opportunity"
          style={{ flex: 1 }}
        >
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.emoji} {a.name} ({a.format})
            </option>
          ))}
        </select>
        <Button variant="primary" size="sm" onClick={launch} disabled={launching || !agentId} data-testid="opportunity-launch">
          {launching ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> : <Play size={13} />}
          Assign
        </Button>
      </div>
    </Card>
  );
}

/**
 * R2.8.1 — detect a data-quality crisis from the scan's per-engine summaries.
 *
 * "No gaps" and "nothing was answered" are different screens. An all-errored
 * scan has no gaps because every prompt errored — not because the brand is
 * cited. Without this gate, OpportunitiesPanel renders the clean "your brand
 * is cited across the tracked queries" message on a scan where nothing was
 * measured.
 *
 * True when at least one engine ran (had non-branded queries) and EVERY engine
 * that ran reported data_source_issue, or when no engine had any answers at all.
 */
function hasCriticalDataSourceIssue(scan) {
  const engines = scan?.engines;
  if (!engines || typeof engines !== "object") {
    // No per-engine data — fall back to the scan-level flag if present.
    return !!(scan?.data_source_issue);
  }
  const slices = Object.values(engines).filter((s) => s && typeof s === "object");
  if (slices.length === 0) return false;
  // Did any engine actually run (had non-branded queries)?
  const ran = slices.filter((s) => Number(s.non_branded_queries) > 0);
  if (ran.length === 0) return false;
  // R2.8.1 — "nothing was answered" is different from "no gaps": every engine
  // that ran reported a data source issue, so no gaps can be found because
  // nothing was measured, not because the brand is cited.
  return ran.every((s) => s.data_source_issue);
}

/**
 * Opportunities — the scan → OS bridge. Turns the latest scan's gaps into
 * actionable cards: what you're losing, where the citations come from, the
 * format that wins, and one click to point an agent at it.
 */
export function OpportunitiesPanel({ brand, scan, agents, onLaunched }) {
  const gaps = useMemo(() => gapsFromScan(scan), [scan]);
  const [error, setError] = useState(null);

  const launch = async (gap, agentId) => {
    setError(null);
    try {
      const res = await fetch("/api/content", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brand,
          agent_id: agentId,
          input: {
            type: "gap",
            source: "opportunity",
            query: gap.query,
            engine: gap.engines[0] || "aio",
            gap_kind: gap.rank_not_cited ? "rank_not_cited" : "absent",
            answer_text: gap.answer_text || "",
            topic: gap.topic,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Failed to launch");
      onLaunched?.(data.job_id);
    } catch (e) {
      setError(e.message);
    }
  };

  if (!scan) {
    return (
      <Card style={{ padding: "var(--space-9)", textAlign: "center" }}>
        <Radar size={26} style={{ color: "var(--text-3)", margin: "0 auto var(--space-3)" }} />
        <p style={{ fontSize: "13px", color: "var(--text-2)" }}>
          Run a visibility scan first. Its gaps become the opportunities your agents optimize for.
        </p>
      </Card>
    );
  }

  // R2.8.1 — "No gaps" and "nothing was answered" are different screens.
  // An all-errored scan has zero gaps because nothing was measured, not
  // because the brand is cited. Rendering the clean "no gaps" message on a
  // failed scan is the same class defect as reporting a null score as 0%.
  const dataSourceIssue = hasCriticalDataSourceIssue(scan);

  if (dataSourceIssue && gaps.length === 0) {
    return (
      <Card style={{ padding: "var(--space-9)", textAlign: "center" }}>
        <Radar size={26} style={{ color: "var(--text-3)", margin: "0 auto var(--space-3)" }} />
        <p style={{ fontSize: "13px", color: "var(--text-2)" }}>
          Data quality issue — the engines returned errors for most tracked queries. No gap analysis is possible until a clean scan completes.
        </p>
      </Card>
    );
  }

  if (gaps.length === 0) {
    return (
      <Card style={{ padding: "var(--space-9)", textAlign: "center" }}>
        <p style={{ fontSize: "13px", color: "var(--text-3)" }}>No open gaps in the latest scan — your brand is cited across the tracked queries.</p>
      </Card>
    );
  }

  return (
    <div data-testid="opportunities-panel">
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-4)" }}>
        <Radar size={16} style={{ color: "var(--brand)" }} />
        <span style={{ fontSize: "13px", color: "var(--text-2)" }}>
          {gaps.length} {gaps.length === 1 ? "gap" : "gaps"} from your latest scan. The scan is the sensor; assign an agent to close each one.
        </span>
      </div>
      {error && <div style={{ fontSize: "12px", color: "var(--crit)", marginBottom: "var(--space-3)" }}>{error}</div>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: "var(--space-4)" }}>
        {gaps.map((g, i) => (
          <GapCard key={i} gap={g} agents={agents || []} onLaunch={launch} />
        ))}
      </div>
    </div>
  );
}
