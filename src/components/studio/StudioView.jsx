"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2,
  Plus,
  Sparkles,
  BookOpen,
  GraduationCap,
  Inbox,
  AlertCircle,
  FileBarChart,
  Bot,
  Radar,
} from "lucide-react";
import { Card } from "@/components/perceev/Card";
import { Badge } from "@/components/perceev/Badge";
import { Button } from "@/components/perceev/Button";
import { Tabs } from "@/components/perceev/Tabs";
import { ContentItemView } from "./ContentItemView";
import { LessonsPanel } from "./LessonsPanel";
import { BrandBriefEditor } from "./BrandBriefEditor";
import { NewContentForm } from "./NewContentForm";
import { WeeklyReport } from "./WeeklyReport";
import { AgentsPanel } from "./AgentsPanel";
import { OpportunitiesPanel } from "./OpportunitiesPanel";
import { AgentTheater, PipelineStrip } from "./AgentTheater";

const RUNNING_STATUSES = ["pending", "coordinating", "researching", "benchmarking", "drafting", "reviewing"];

const STATUS_GROUPS = [
  { key: "awaiting_approval", label: "Awaiting approval" },
  { key: "changes_requested", label: "In revision" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
];

const stageLabel = {
  pending: "Queued",
  coordinating: "Coordinating",
  researching: "Researching",
  benchmarking: "Benchmarking",
  drafting: "Drafting",
  reviewing: "Reviewing",
};

function agentGlyph(item) {
  return item.agent_snapshot?.emoji || (item.playbook === "linkedin_post" ? "💼" : "📄");
}
function agentName(item) {
  return item.agent_snapshot?.name || (item.playbook === "linkedin_post" ? "LinkedIn CXO" : "GEO Citation Writer");
}

function ItemCard({ item, onOpen }) {
  return (
    <button
      data-testid="studio-item-card"
      onClick={() => onOpen(item.id)}
      style={{
        textAlign: "left",
        background: "var(--bg-1)",
        border: "1px solid var(--border-1)",
        borderRadius: "var(--radius-2)",
        padding: "var(--space-5)",
        cursor: "pointer",
        transition: "border-color var(--dur-fast)",
        width: "100%",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--border-3)")}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--border-1)")}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" }}>
        <span style={{ fontSize: "15px" }}>{agentGlyph(item)}</span>
        <Badge variant="neutral">{item.agent_snapshot?.format || (item.playbook === "linkedin_post" ? "linkedin_post" : "article")}</Badge>
        {item.rubric_verdict && (
          <Badge variant={item.rubric_verdict === "pass" ? "strong" : "weak"}>
            {item.rubric_verdict}
            {item.rubric_total != null ? ` · ${item.rubric_total}` : ""}
          </Badge>
        )}
        {item.ymyl_violation && <Badge variant="weak" dot>YMYL</Badge>}
        {item.below_threshold && <Badge variant="moderate">below threshold</Badge>}
        {item.revision > 0 && <Badge variant="muted">rev {item.revision}</Badge>}
      </div>
      <div style={{ fontFamily: "var(--font-sans)", fontSize: "14px", fontWeight: 600, color: "var(--text-1)", marginTop: "var(--space-3)", lineHeight: 1.4 }}>
        {item.title || "(untitled)"}
      </div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "var(--text-3)", marginTop: "var(--space-2)" }}>
        {agentName(item)}
        {(item.target_queries || []).length > 0 && ` · ${item.target_queries.length} target ${item.target_queries.length === 1 ? "query" : "queries"}`}
        {` · ${new Date(item.updated_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`}
      </div>
    </button>
  );
}

function JobCard({ job, onOpen }) {
  const failed = job.status === "failed";
  const agent = job.agent_snapshot || {};
  const active = (job.agent_trace || []).find((t) => t.status === "working");
  return (
    <button
      data-testid="studio-job-card"
      onClick={() => onOpen(job.id)}
      style={{
        textAlign: "left",
        width: "100%",
        background: "var(--bg-1)",
        border: `1px solid ${failed ? "var(--crit-border)" : "var(--border-1)"}`,
        borderRadius: "var(--radius-2)",
        padding: "var(--space-5)",
        cursor: "pointer",
        transition: "border-color var(--dur-fast)",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = failed ? "var(--crit)" : "var(--accent-border)")}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = failed ? "var(--crit-border)" : "var(--border-1)")}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <span style={{ fontSize: "16px" }}>{agent.emoji || "🤖"}</span>
        <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-1)" }}>{agent.name || job.playbook}</span>
        <Badge variant={failed ? "weak" : "accent"} dot>
          {failed ? "failed" : stageLabel[job.status] || job.status}
        </Badge>
        <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--text-2)" }}>
          {failed ? "" : `${job.progress_pct || 0}%`}
        </span>
      </div>

      {job.agent_trace?.length > 0 && (
        <div style={{ marginTop: "var(--space-3)" }}>
          <PipelineStrip trace={job.agent_trace} />
        </div>
      )}

      {active && !failed && (
        <div style={{ marginTop: "var(--space-2)", fontSize: "11px", color: "var(--accent-text)" }}>
          {active.emoji} {active.name}: {active.activity}
        </div>
      )}

      {failed ? (
        <div style={{ fontSize: "12px", color: "var(--crit)", marginTop: "var(--space-3)", lineHeight: 1.5 }}>{job.error_message || "Pipeline error"}</div>
      ) : (
        <div style={{ marginTop: "var(--space-3)", height: "4px", background: "var(--bg-2)", borderRadius: "2px", overflow: "hidden" }}>
          <div style={{ width: `${job.progress_pct || 0}%`, height: "100%", background: "var(--accent)", transition: "width 600ms var(--ease-out)" }} />
        </div>
      )}
    </button>
  );
}

/**
 * Studio — the human side of the OS. Agents you build, opportunities from the
 * scan, a queue of runs (with the live theater), and the review/approve gate.
 */
export function StudioView({ brand, scan, initialItemId = null, onCountsChange }) {
  const [tab, setTab] = useState("queue");
  const [items, setItems] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [agents, setAgents] = useState([]);
  const [openItemId, setOpenItemId] = useState(initialItemId);
  const [openJobId, setOpenJobId] = useState(null);
  const [loaded, setLoaded] = useState(false);

  const onCountsChangeRef = useRef(onCountsChange);
  onCountsChangeRef.current = onCountsChange;

  const refresh = useCallback(async () => {
    try {
      const [itemsRes, jobsRes, agentsRes] = await Promise.all([
        fetch(`/api/content-items?brand=${encodeURIComponent(brand || "")}`, { cache: "no-store" }),
        fetch(`/api/content?brand=${encodeURIComponent(brand || "")}`, { cache: "no-store" }),
        fetch(`/api/agents?brand=${encodeURIComponent(brand || "")}`, { cache: "no-store" }),
      ]);
      if (itemsRes.ok) {
        const data = await itemsRes.json();
        setItems(data.items || []);
        onCountsChangeRef.current?.({
          awaiting: (data.items || []).filter((i) => i.status === "awaiting_approval").length,
        });
      }
      if (jobsRes.ok) setJobs((await jobsRes.json()).jobs || []);
      if (agentsRes.ok) setAgents((await agentsRes.json()).agents || []);
    } catch (e) {
      console.warn("Studio refresh failed:", e.message);
    } finally {
      setLoaded(true);
    }
  }, [brand]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Re-sync on tab change so a newly-built agent shows up immediately in the
  // Opportunities / New-run pickers (the Agents tab creates it out of band).
  useEffect(() => {
    refresh();
  }, [tab, refresh]);

  const hasActivity =
    jobs.some((j) => RUNNING_STATUSES.includes(j.status)) || items.some((i) => i.status === "changes_requested");
  useEffect(() => {
    if (!hasActivity) return;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [hasActivity, refresh]);

  const runningJobs = useMemo(
    () => jobs.filter((j) => RUNNING_STATUSES.includes(j.status) || j.status === "failed").slice(0, 8),
    [jobs]
  );
  const liveCount = useMemo(() => jobs.filter((j) => RUNNING_STATUSES.includes(j.status)).length, [jobs]);

  const grouped = useMemo(() => {
    const g = {};
    for (const group of STATUS_GROUPS) g[group.key] = [];
    for (const item of items) if (g[item.status]) g[item.status].push(item);
    return g;
  }, [items]);

  const awaitingCount = grouped.awaiting_approval.length;

  const launchToTheater = (jobId) => {
    setOpenItemId(null);
    setOpenJobId(jobId);
    setTab("queue");
    refresh();
  };

  // --- routed sub-views ---
  if (openJobId) {
    return (
      <AgentTheater
        jobId={openJobId}
        onBack={() => {
          setOpenJobId(null);
          refresh();
        }}
        onOpenItem={(itemId) => {
          setOpenJobId(null);
          setOpenItemId(itemId);
        }}
      />
    );
  }
  if (openItemId) {
    return (
      <ContentItemView
        itemId={openItemId}
        onBack={() => {
          setOpenItemId(null);
          refresh();
        }}
        onDecided={() => refresh()}
      />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)", height: "100%", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0, gap: "var(--space-3)", flexWrap: "wrap" }}>
        <Tabs
          active={tab}
          onChange={setTab}
          items={[
            { key: "queue", label: "Queue", count: awaitingCount || null, testId: "studio-tab-queue" },
            { key: "agents", label: "Agents", testId: "studio-tab-agents" },
            { key: "opportunities", label: "Opportunities", testId: "studio-tab-opportunities" },
            { key: "report", label: "Report", testId: "studio-tab-report" },
            { key: "lessons", label: "Lessons", testId: "studio-tab-lessons" },
            { key: "brief", label: "Brand brief", testId: "studio-tab-brief" },
          ]}
        />
        <Button variant="primary" size="sm" onClick={() => setTab("new")} data-testid="studio-new-content">
          <Plus size={14} /> New run
        </Button>
      </div>

      {/* Live activity banner across all tabs */}
      {liveCount > 0 && tab !== "queue" && (
        <button
          onClick={() => setTab("queue")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            background: "var(--accent-soft)",
            border: "1px solid var(--accent-border)",
            borderRadius: "var(--radius-1)",
            padding: "var(--space-2) var(--space-4)",
            color: "var(--accent-text)",
            fontSize: "12px",
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} />
          {liveCount} {liveCount === 1 ? "agent is" : "agents are"} working now — watch them →
        </button>
      )}

      <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {tab === "queue" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
            {runningJobs.length > 0 && (
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "var(--space-3)" }}>
                  <Bot size={13} style={{ color: "var(--accent)" }} />
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: "10px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--text-2)" }}>
                    Agents at work ({runningJobs.length})
                  </span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: "var(--space-4)" }}>
                  {runningJobs.map((j) => (
                    <JobCard key={j.id} job={j} onOpen={setOpenJobId} />
                  ))}
                </div>
              </div>
            )}

            {loaded && items.length === 0 && runningJobs.length === 0 && (
              <Card style={{ padding: "var(--space-9)", textAlign: "center" }} data-testid="studio-empty">
                <Sparkles size={28} style={{ color: "var(--accent)", margin: "0 auto var(--space-4)" }} />
                <h3 style={{ fontFamily: "var(--font-sans)", fontSize: "17px", fontWeight: 600, color: "var(--text-1)" }}>No content yet</h3>
                <p style={{ fontSize: "13px", color: "var(--text-2)", marginTop: "var(--space-2)", lineHeight: 1.6 }}>
                  Point an agent at a scan gap in <strong>Opportunities</strong>, or start a run from scratch.
                </p>
                <div style={{ marginTop: "var(--space-5)", display: "flex", gap: "var(--space-2)", justifyContent: "center" }}>
                  <Button variant="primary" size="md" onClick={() => setTab("opportunities")}>
                    <Radar size={14} /> See opportunities
                  </Button>
                  <Button variant="secondary" size="md" onClick={() => setTab("new")}>
                    <Plus size={14} /> New run
                  </Button>
                </div>
              </Card>
            )}

            {STATUS_GROUPS.map((group) => {
              const list = grouped[group.key];
              if (!list || list.length === 0) return null;
              return (
                <div key={group.key} data-testid={`studio-group-${group.key}`}>
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
                    {group.key === "awaiting_approval" && <Inbox size={12} style={{ color: "var(--accent)" }} />}
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: "10px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em", color: group.key === "awaiting_approval" ? "var(--accent-text)" : "var(--text-2)" }}>
                      {group.label} ({list.length})
                    </span>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "var(--space-4)" }}>
                    {list.map((item) => (
                      <ItemCard key={item.id} item={item} onOpen={setOpenItemId} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {tab === "agents" && <AgentsPanel brand={brand} onRun={(agent) => setTab({ new: agent.id })} />}

        {tab === "opportunities" && (
          <OpportunitiesPanel brand={brand} scan={scan} agents={agents} onLaunched={launchToTheater} />
        )}

        {tab === "report" && (
          <div style={{ maxWidth: "760px" }}>
            <WeeklyReport brand={brand} />
          </div>
        )}

        {tab === "lessons" && (
          <div style={{ maxWidth: "760px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-4)" }}>
              <GraduationCap size={16} style={{ color: "var(--accent)" }} />
              <span style={{ fontSize: "13px", color: "var(--text-2)" }}>
                Lessons distilled from your feedback — injected into every future run for this brand.
              </span>
            </div>
            <LessonsPanel brand={brand} />
          </div>
        )}

        {tab === "brief" && (
          <div style={{ maxWidth: "760px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-4)" }}>
              <BookOpen size={16} style={{ color: "var(--accent)" }} />
              <span style={{ fontSize: "13px", color: "var(--text-2)" }}>
                The Brand Brief is written once and inherited by every agent — never re-explained per run.
              </span>
            </div>
            <BrandBriefEditor brand={brand} />
          </div>
        )}

        {(tab === "new" || (tab && typeof tab === "object" && tab.new)) && (
          <div style={{ maxWidth: "560px" }}>
            <NewContentForm
              brand={brand}
              agents={agents}
              presetAgentId={typeof tab === "object" ? tab.new : undefined}
              onLaunched={launchToTheater}
            />
          </div>
        )}
      </div>
    </div>
  );
}
