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

const RUNNING_STATUSES = [
  "pending",
  "coordinating",
  "researching",
  "benchmarking",
  "drafting",
  "reviewing",
];

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
        <Badge variant="neutral">{item.playbook === "geo_article" ? "GEO article" : "LinkedIn post"}</Badge>
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
      <div
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: "14px",
          fontWeight: 600,
          color: "var(--text-1)",
          marginTop: "var(--space-3)",
          lineHeight: 1.4,
        }}
      >
        {item.title || "(untitled)"}
      </div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "var(--text-3)", marginTop: "var(--space-2)" }}>
        {item.brand}
        {(item.target_queries || []).length > 0 && ` · ${item.target_queries.length} target ${item.target_queries.length === 1 ? "query" : "queries"}`}
        {` · ${new Date(item.updated_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`}
      </div>
    </button>
  );
}

function JobCard({ job }) {
  const failed = job.status === "failed";
  return (
    <div
      data-testid="studio-job-card"
      style={{
        background: "var(--bg-1)",
        border: `1px solid ${failed ? "var(--crit-border)" : "var(--border-1)"}`,
        borderRadius: "var(--radius-2)",
        padding: "var(--space-5)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        {failed ? (
          <AlertCircle size={14} style={{ color: "var(--crit)" }} />
        ) : (
          <Loader2 size={14} style={{ color: "var(--accent)", animation: "spin 1s linear infinite" }} />
        )}
        <Badge variant="neutral">{job.playbook === "geo_article" ? "GEO article" : "LinkedIn post"}</Badge>
        <Badge variant={failed ? "weak" : "accent"} dot>
          {failed ? "failed" : stageLabel[job.status] || job.status}
        </Badge>
        {!failed && (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--text-2)", marginLeft: "auto" }}>
            {job.progress_pct}%
          </span>
        )}
      </div>
      {failed ? (
        <div style={{ fontSize: "12px", color: "var(--crit)", marginTop: "var(--space-3)", lineHeight: 1.5 }}>
          {job.error_message || "Pipeline error"}
        </div>
      ) : (
        <div style={{ marginTop: "var(--space-3)", height: "4px", background: "var(--bg-2)", borderRadius: "2px", overflow: "hidden" }}>
          <div
            style={{
              width: `${job.progress_pct || 0}%`,
              height: "100%",
              background: "var(--accent)",
              transition: "width 600ms var(--ease-out)",
            }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Studio — the human side of the content pipeline. Queue of items by
 * status, in-flight job cards, item review with approve/changes/reject,
 * lessons panel, and the brand-brief editor.
 */
export function StudioView({ brand, initialItemId = null, onCountsChange }) {
  const [tab, setTab] = useState("queue");
  const [items, setItems] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [openItemId, setOpenItemId] = useState(initialItemId);
  const [loaded, setLoaded] = useState(false);

  // Callers pass inline callbacks; a ref keeps `refresh` referentially
  // stable so the polling effect doesn't re-arm on every parent render.
  const onCountsChangeRef = useRef(onCountsChange);
  onCountsChangeRef.current = onCountsChange;

  const refresh = useCallback(async () => {
    try {
      const [itemsRes, jobsRes] = await Promise.all([
        fetch(`/api/content-items?brand=${encodeURIComponent(brand || "")}`, { cache: "no-store" }),
        fetch(`/api/content?brand=${encodeURIComponent(brand || "")}`, { cache: "no-store" }),
      ]);
      if (itemsRes.ok) {
        const data = await itemsRes.json();
        setItems(data.items || []);
        onCountsChangeRef.current?.({
          awaiting: (data.items || []).filter((i) => i.status === "awaiting_approval").length,
        });
      }
      if (jobsRes.ok) {
        const data = await jobsRes.json();
        setJobs(data.jobs || []);
      }
    } catch (e) {
      console.warn("Studio refresh failed:", e.message);
    } finally {
      setLoaded(true);
    }
  }, [brand]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Poll while anything is in flight (jobs running or revisions pending).
  const hasActivity =
    jobs.some((j) => RUNNING_STATUSES.includes(j.status)) ||
    items.some((i) => i.status === "changes_requested");
  useEffect(() => {
    if (!hasActivity) return;
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [hasActivity, refresh]);

  const runningJobs = useMemo(
    () => jobs.filter((j) => RUNNING_STATUSES.includes(j.status) || j.status === "failed").slice(0, 6),
    [jobs]
  );

  const grouped = useMemo(() => {
    const g = {};
    for (const group of STATUS_GROUPS) g[group.key] = [];
    for (const item of items) {
      if (g[item.status]) g[item.status].push(item);
    }
    return g;
  }, [items]);

  const awaitingCount = grouped.awaiting_approval.length;

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
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
        <Tabs
          active={tab}
          onChange={setTab}
          items={[
            { key: "queue", label: "Queue", count: awaitingCount || null, testId: "studio-tab-queue" },
            { key: "report", label: "Report", testId: "studio-tab-report" },
            { key: "lessons", label: "Lessons", testId: "studio-tab-lessons" },
            { key: "brief", label: "Brand brief", testId: "studio-tab-brief" },
          ]}
        />
        <Button
          data-testid="studio-new-content"
          variant="primary"
          size="sm"
          onClick={() => setTab("new")}
        >
          <Plus size={14} />
          New content
        </Button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {tab === "queue" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
            {runningJobs.length > 0 && (
              <div>
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "10px",
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.1em",
                    color: "var(--text-2)",
                    marginBottom: "var(--space-3)",
                  }}
                >
                  Pipeline activity
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "var(--space-4)" }}>
                  {runningJobs.map((j) => (
                    <JobCard key={j.id} job={j} />
                  ))}
                </div>
              </div>
            )}

            {loaded && items.length === 0 && runningJobs.length === 0 && (
              <Card style={{ padding: "var(--space-9)", textAlign: "center" }} data-testid="studio-empty">
                <Sparkles size={28} style={{ color: "var(--accent)", margin: "0 auto var(--space-4)" }} />
                <h3 style={{ fontFamily: "var(--font-sans)", fontSize: "17px", fontWeight: 600, color: "var(--text-1)" }}>
                  No content yet
                </h3>
                <p style={{ fontSize: "13px", color: "var(--text-2)", marginTop: "var(--space-2)", lineHeight: 1.6 }}>
                  Generate your first piece from a scan gap (Answers view → &quot;Generate content&quot; on an absent query)
                  or start from a topic with New content.
                </p>
                <div style={{ marginTop: "var(--space-5)" }}>
                  <Button variant="primary" size="md" onClick={() => setTab("new")}>
                    <Plus size={14} />
                    New content
                  </Button>
                </div>
              </Card>
            )}

            {STATUS_GROUPS.map((group) => {
              const list = grouped[group.key];
              if (!list || list.length === 0) return null;
              return (
                <div key={group.key} data-testid={`studio-group-${group.key}`}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--space-2)",
                      marginBottom: "var(--space-3)",
                    }}
                  >
                    {group.key === "awaiting_approval" && <Inbox size={12} style={{ color: "var(--accent)" }} />}
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "10px",
                        fontWeight: 600,
                        textTransform: "uppercase",
                        letterSpacing: "0.1em",
                        color: group.key === "awaiting_approval" ? "var(--accent-text)" : "var(--text-2)",
                      }}
                    >
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
                Lessons distilled from your feedback — injected into every future prompt for this brand. Toggle off any that stop being true.
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
                The Brand Brief is written once and inherited by every pipeline step — it is never re-explained per prompt.
              </span>
            </div>
            <BrandBriefEditor brand={brand} />
          </div>
        )}

        {tab === "new" && (
          <div style={{ maxWidth: "560px" }}>
            <NewContentForm
              brand={brand}
              onStarted={() => {
                setTab("queue");
                refresh();
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
