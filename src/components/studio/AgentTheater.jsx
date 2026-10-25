"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Check, X, ArrowRight, ArrowLeft, CircleDot, FileText } from "lucide-react";
import { Card } from "@/components/perceev/Card";
import { Badge } from "@/components/perceev/Badge";
import { Button } from "@/components/perceev/Button";

const RUNNING = ["pending", "coordinating", "researching", "benchmarking", "drafting", "reviewing"];

function StatusDot({ status }) {
  if (status === "working")
    return <Loader2 size={13} style={{ color: "var(--brand)", animation: "spin 1s linear infinite" }} />;
  if (status === "done") return <Check size={13} style={{ color: "var(--good)" }} />;
  if (status === "failed") return <X size={13} style={{ color: "var(--crit)" }} />;
  return <CircleDot size={13} style={{ color: "var(--text-3)", opacity: 0.5 }} />;
}

/**
 * One specialist lane. Shows the crew member lighting up as it works, with its
 * live activity line and, on completion, the one-line summary of what it made.
 */
export function SpecialistCard({ member, compact }) {
  const working = member.status === "working";
  const done = member.status === "done";
  const failed = member.status === "failed";
  const border = working
    ? "var(--accent-border)"
    : failed
      ? "var(--crit-border)"
      : "var(--border-1)";
  const bg = working ? "var(--accent-soft)" : "var(--bg-1)";

  return (
    <div
      data-testid="specialist-card"
      data-status={member.status}
      style={{
        flex: compact ? "0 0 auto" : "1 1 0",
        minWidth: compact ? "auto" : "150px",
        border: `1px solid ${border}`,
        borderRadius: "var(--radius-2)",
        background: bg,
        padding: compact ? "var(--space-3)" : "var(--space-4)",
        opacity: member.status === "pending" ? 0.55 : 1,
        transition: "all var(--dur-fast)",
        boxShadow: working ? "0 0 0 3px var(--accent-soft)" : "none",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <span style={{ fontSize: compact ? "16px" : "20px", filter: member.status === "pending" ? "grayscale(1)" : "none" }}>
          {member.emoji}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-1)" }}>{member.name}</div>
          {!compact && <div style={{ fontSize: "9px", color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{member.role}</div>}
        </div>
        <StatusDot status={member.status} />
      </div>
      {(working || done || failed) && (
        <div
          style={{
            marginTop: "8px",
            fontSize: "11px",
            lineHeight: 1.45,
            color: failed ? "var(--crit)" : working ? "var(--accent-text)" : "var(--text-2)",
          }}
        >
          {working ? (member.activity || "Working…") : member.summary || (done ? "Done" : "")}
          {member.cycle > 1 && working && (
            <span style={{ marginLeft: "4px", opacity: 0.7 }}>· pass {member.cycle}</span>
          )}
        </div>
      )}
    </div>
  );
}

/** A tiny inline strip of the pipeline for the queue "activity" row. */
export function PipelineStrip({ trace }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "4px", flexWrap: "wrap" }}>
      {(trace || []).map((m, i) => (
        <div key={m.step} style={{ display: "flex", alignItems: "center", gap: "4px" }}>
          <span
            title={`${m.name}: ${m.status}${m.summary ? " — " + m.summary : m.activity ? " — " + m.activity : ""}`}
            style={{
              fontSize: "13px",
              filter: m.status === "pending" ? "grayscale(1)" : "none",
              opacity: m.status === "pending" ? 0.4 : 1,
            }}
          >
            {m.emoji}
          </span>
          {m.status === "working" && (
            <Loader2 size={10} style={{ color: "var(--brand)", animation: "spin 1s linear infinite" }} />
          )}
          {i < trace.length - 1 && <span style={{ color: "var(--text-3)", fontSize: "9px" }}>›</span>}
        </div>
      ))}
    </div>
  );
}

/**
 * Full theater for one job: the operator (custom Agent) header, and its crew
 * of five specialists working live. Polls the job status while running.
 */
export function AgentTheater({ jobId, onBack, onOpenItem }) {
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);

  const fetchJob = useCallback(async () => {
    try {
      const res = await fetch(`/api/content/${jobId}/status`, { cache: "no-store" });
      if (!res.ok) throw new Error((await res.json()).detail || "Failed to load run");
      setJob(await res.json());
    } catch (e) {
      setError(e.message);
    }
  }, [jobId]);

  useEffect(() => {
    fetchJob();
  }, [fetchJob]);

  const isRunning = job && RUNNING.includes(job.status);
  useEffect(() => {
    if (!isRunning) return;
    const t = setInterval(fetchJob, 2000);
    return () => clearInterval(t);
  }, [isRunning, fetchJob]);

  if (!job) {
    return (
      <div style={{ padding: "var(--space-9)", textAlign: "center", color: "var(--text-3)" }}>
        {error ? error : <Loader2 size={22} style={{ animation: "spin 1s linear infinite" }} />}
      </div>
    );
  }

  const agent = job.agent_snapshot || { name: job.playbook === "linkedin_post" ? "LinkedIn CXO" : "GEO Citation Writer", emoji: "🤖", format: job.playbook };
  const trace = job.agent_trace && job.agent_trace.length ? job.agent_trace : [];
  const done = job.status === "awaiting_approval";
  const failed = job.status === "failed";
  const targetQuery = job.input?.query;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)", height: "100%", overflow: "auto" }} data-testid="agent-theater">
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
        {onBack && (
          <Button variant="secondary" size="sm" onClick={onBack}>
            <ArrowLeft size={14} /> Back
          </Button>
        )}
      </div>

      {/* Operator header */}
      <Card style={{ padding: "var(--space-6)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-4)" }}>
          <div
            style={{
              width: "52px",
              height: "52px",
              borderRadius: "var(--radius-2)",
              background: "var(--accent-soft)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "28px",
              flexShrink: 0,
            }}
          >
            {agent.emoji}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" }}>
              <h2 style={{ fontFamily: "var(--font-sans)", fontSize: "18px", fontWeight: 600, color: "var(--text-1)" }}>{agent.name}</h2>
              <Badge variant="neutral">{agent.format}</Badge>
              {agent.channel && <Badge variant="muted">→ {agent.channel}</Badge>}
              <Badge variant={done ? "strong" : failed ? "weak" : "accent"} dot>
                {done ? "ready for review" : failed ? "failed" : "running"}
              </Badge>
            </div>
            {targetQuery && (
              <div style={{ fontSize: "12px", color: "var(--text-2)", marginTop: "4px" }}>
                Optimizing for: <span style={{ color: "var(--text-1)", fontWeight: 500 }}>&ldquo;{targetQuery}&rdquo;</span>
              </div>
            )}
          </div>
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: "20px", fontWeight: 600, color: "var(--text-1)" }}>{job.progress_pct || 0}%</div>
            {job.cost_total > 0 && <div style={{ fontSize: "10px", color: "var(--text-3)" }}>${Number(job.cost_total).toFixed(3)}</div>}
          </div>
        </div>
      </Card>

      {failed && (
        <Card style={{ padding: "var(--space-4)", border: "1px solid var(--crit-border)" }}>
          <div style={{ fontSize: "12px", color: "var(--crit)" }}>{job.error_message || "Pipeline error"}</div>
        </Card>
      )}

      {/* The crew, live */}
      <div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: "10px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--text-2)", marginBottom: "var(--space-3)" }}>
          The crew
        </div>
        <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "stretch", flexWrap: "wrap" }}>
          {trace.map((m, i) => (
            <div key={m.step} style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flex: "1 1 150px" }}>
              <div style={{ flex: 1 }}>
                <SpecialistCard member={m} />
              </div>
              {i < trace.length - 1 && (
                <ArrowRight size={14} style={{ color: "var(--text-3)", flexShrink: 0 }} />
              )}
            </div>
          ))}
        </div>
      </div>

      {done && job.item_id && (
        <div>
          <Button variant="primary" size="md" onClick={() => onOpenItem?.(job.item_id)} data-testid="theater-review">
            <FileText size={14} /> Review the output
          </Button>
        </div>
      )}
    </div>
  );
}
