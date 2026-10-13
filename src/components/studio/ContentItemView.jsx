"use client";

import { useEffect, useState, useCallback } from "react";
import {
  ArrowLeft,
  Check,
  X,
  MessageSquareWarning,
  Copy,
  ClipboardCheck,
  Loader2,
  ShieldAlert,
  ExternalLink,
  TrendingUp,
} from "lucide-react";
import { Card } from "@/components/perceev/Card";
import { Badge } from "@/components/perceev/Badge";
import { Button } from "@/components/perceev/Button";
import { Tabs } from "@/components/perceev/Tabs";
import { Markdown } from "./Markdown";

const monoLabel = {
  fontFamily: "var(--font-mono)",
  fontSize: "9px",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.1em",
  color: "var(--text-3)",
};

function ScoreRow({ dim, score }) {
  const color = score >= 0.75 ? "var(--good)" : score >= 0.6 ? "var(--warn)" : "var(--crit)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
      <span style={{ ...monoLabel, width: "180px", flexShrink: 0 }}>{dim.replace(/_/g, " ")}</span>
      <div style={{ flex: 1, height: "6px", background: "var(--bg-2)", borderRadius: "3px", overflow: "hidden" }}>
        <div style={{ width: `${Math.round(score * 100)}%`, height: "100%", background: color }} />
      </div>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: "11px", fontWeight: 600, color, width: "36px", textAlign: "right" }}>
        {score.toFixed(2)}
      </span>
    </div>
  );
}

function markdownToPlaintext(md) {
  return String(md || "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/^>\s?/gm, "");
}

export function ContentItemView({ itemId, onBack, onDecided }) {
  const [item, setItem] = useState(null);
  const [tab, setTab] = useState("draft");
  const [comment, setComment] = useState("");
  const [deciding, setDeciding] = useState(null);
  const [copied, setCopied] = useState(null);
  const [error, setError] = useState(null);
  const [lift, setLift] = useState(null);

  const fetchItem = useCallback(async () => {
    try {
      const res = await fetch(`/api/content-items/${itemId}`, { cache: "no-store" });
      if (!res.ok) throw new Error((await res.json()).detail || "Failed to load item");
      const data = await res.json();
      setItem(data.item);
    } catch (e) {
      setError(e.message);
    }
  }, [itemId]);

  useEffect(() => {
    fetchItem();
  }, [fetchItem]);

  // GEO lift for approved geo_articles — target queries visible/cited since publish.
  useEffect(() => {
    if (item?.playbook !== "geo_article" || item?.status !== "approved") return;
    fetch(`/api/content-items/${itemId}/lift`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.applicable && setLift(d))
      .catch(() => {});
  }, [item?.playbook, item?.status, itemId]);

  // While a revision is in flight (changes_requested), poll for the redraft.
  useEffect(() => {
    if (item?.status !== "changes_requested") return;
    const t = setInterval(fetchItem, 4000);
    return () => clearInterval(t);
  }, [item?.status, fetchItem]);

  const decide = async (verdict) => {
    if ((verdict === "changes_requested" || verdict === "rejected") && !comment.trim()) {
      setError(
        verdict === "changes_requested"
          ? "A comment is required to request changes — it becomes the revision brief."
          : "A comment is required to reject — it becomes a stored lesson."
      );
      return;
    }
    setDeciding(verdict);
    setError(null);
    try {
      const res = await fetch(`/api/content-items/${itemId}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verdict, comment: comment.trim() }),
      });
      if (!res.ok) throw new Error((await res.json()).detail || "Decision failed");
      setComment("");
      await fetchItem();
      onDecided?.(verdict);
    } catch (e) {
      setError(e.message);
    } finally {
      setDeciding(null);
    }
  };

  const copyText = async (kind) => {
    const text = kind === "markdown" ? item.body_md : markdownToPlaintext(item.body_md);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      setError("Clipboard unavailable — select and copy manually.");
    }
  };

  if (!item) {
    return (
      <div style={{ padding: "var(--space-9)", textAlign: "center", color: "var(--text-3)" }}>
        {error ? error : <Loader2 size={22} style={{ animation: "spin 1s linear infinite" }} />}
      </div>
    );
  }

  const rubric = item.rubric || {};
  const research = item.research_pack || {};
  const benchmark = { ...(item.benchmark_notes || {}) };
  const workOrder = benchmark.work_order;
  delete benchmark.work_order;
  const isAwaiting = item.status === "awaiting_approval";
  const isRevising = item.status === "changes_requested";

  const statusVariant =
    item.status === "approved"
      ? "strong"
      : item.status === "rejected"
        ? "weak"
        : item.status === "awaiting_approval"
          ? "accent"
          : "moderate";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)", height: "100%", overflow: "hidden" }}>
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-4)", flexShrink: 0 }}>
        <Button variant="secondary" size="sm" onClick={onBack} data-testid="studio-item-back">
          <ArrowLeft size={14} />
          Queue
        </Button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2
            data-testid="studio-item-title"
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "17px",
              fontWeight: 600,
              color: "var(--text-1)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {item.title || "(untitled)"}
          </h2>
          <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "4px", flexWrap: "wrap" }}>
            <Badge variant="neutral">{item.playbook === "geo_article" ? "GEO article" : "LinkedIn post"}</Badge>
            <Badge variant={statusVariant} dot>{item.status.replace(/_/g, " ")}</Badge>
            {rubric.verdict && (
              <Badge variant={rubric.verdict === "pass" ? "strong" : "weak"}>
                rubric {rubric.verdict} {rubric.weighted_total != null ? `· ${rubric.weighted_total}` : ""}
              </Badge>
            )}
            {rubric.ymyl_violation && <Badge variant="weak" dot>YMYL flag</Badge>}
            {rubric.below_threshold && <Badge variant="moderate">below threshold</Badge>}
            {item.revision > 0 && <Badge variant="muted">rev {item.revision}</Badge>}
          </div>
        </div>
        <div style={{ display: "flex", gap: "var(--space-2)", flexShrink: 0 }}>
          <Button variant="secondary" size="sm" onClick={() => copyText("markdown")}>
            {copied === "markdown" ? <ClipboardCheck size={14} /> : <Copy size={14} />}
            {copied === "markdown" ? "Copied" : "Copy MD"}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => copyText("plain")} data-testid="studio-copy-plain">
            {copied === "plain" ? <ClipboardCheck size={14} /> : <Copy size={14} />}
            {copied === "plain" ? "Copied" : "Copy text"}
          </Button>
        </div>
      </div>

      {isRevising && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-3)",
            background: "var(--warn-bg)",
            border: "1px solid var(--warn-border)",
            borderRadius: "var(--radius-1)",
            padding: "var(--space-3) var(--space-4)",
            color: "var(--warn)",
            fontSize: "12px",
            flexShrink: 0,
          }}
        >
          <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
          Revision in progress — the agent is redrafting from your comment. This view refreshes automatically.
        </div>
      )}

      {lift && (
        <div
          data-testid="studio-lift"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-3)",
            background: lift.cited_delta > 0 ? "var(--good-bg)" : "var(--bg-1)",
            border: `1px solid ${lift.cited_delta > 0 ? "var(--good-border)" : "var(--border-1)"}`,
            borderRadius: "var(--radius-1)",
            padding: "var(--space-3) var(--space-4)",
            fontSize: "12px",
            color: lift.cited_delta > 0 ? "var(--good)" : "var(--text-2)",
            flexShrink: 0,
          }}
        >
          <TrendingUp size={14} />
          {lift.has_post_scan ? (
            <span>
              GEO lift: <strong>{lift.target_count}</strong> target{" "}
              {lift.target_count === 1 ? "query" : "queries"} → cited on{" "}
              <strong>{lift.after.cited}</strong> (was {lift.before.cited}), visible on{" "}
              <strong>{lift.after.visible}</strong> since approval.
              {lift.cited_delta > 0 && ` +${lift.cited_delta} newly cited.`}
              {/* R5.2.3 — the approve→publish→lift pipeline has not been
                  proven end-to-end; this is a correlation, not a causal
                  measurement.  The caveat stays until the pipeline runs
                  once with a verified live URL (R5.2.2) and a post-publish
                  re-scan confirms the lift is real. */}
            </span>
          ) : (
            <span>
              Tracking <strong>{lift.target_count}</strong> target{" "}
              {lift.target_count === 1 ? "query" : "queries"} — re-scan the brand to measure lift since approval.
            </span>
          )}
        </div>
      )}

      {/* YMYL violations called out above the fold, always */}
      {rubric.ymyl_violation && (rubric.violations || []).some((v) => v.ymyl) && (
        <div
          style={{
            background: "var(--crit-bg)",
            border: "1px solid var(--crit-border)",
            borderRadius: "var(--radius-1)",
            padding: "var(--space-4)",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", color: "var(--crit)", fontWeight: 600, fontSize: "13px" }}>
            <ShieldAlert size={16} />
            YMYL check failed — never auto-passed. Your call:
          </div>
          <ul style={{ margin: "var(--space-2) 0 0", paddingLeft: "24px", display: "flex", flexDirection: "column", gap: "4px" }}>
            {(rubric.violations || [])
              .filter((v) => v.ymyl)
              .map((v, i) => (
                <li key={i} style={{ fontSize: "12px", color: "var(--crit)" }}>
                  {v.detail || v.rule}
                </li>
              ))}
          </ul>
        </div>
      )}

      <Tabs
        active={tab}
        onChange={setTab}
        items={[
          { key: "draft", label: "Draft", testId: "studio-tab-draft" },
          { key: "research", label: "Research pack", count: (research.sources || []).length, testId: "studio-tab-research" },
          { key: "benchmark", label: "Benchmark", testId: "studio-tab-benchmark" },
          { key: "rubric", label: "Rubric", count: (rubric.violations || []).length || null, testId: "studio-tab-rubric" },
          { key: "revisions", label: "Revisions", count: (item.revisions || []).length || null, testId: "studio-tab-revisions" },
        ]}
      />

      {/* Tab content */}
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {tab === "draft" && (
          <Card variant="flush" style={{ padding: "var(--space-7)", maxWidth: "760px" }} data-testid="studio-draft-body">
            <Markdown>{item.body_md}</Markdown>
          </Card>
        )}

        {tab === "research" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)", maxWidth: "760px" }}>
            <Card variant="flush" style={{ padding: "var(--space-5)" }}>
              <div style={{ ...monoLabel, marginBottom: "var(--space-3)" }}>Sources ({(research.sources || []).length})</div>
              {(research.sources || []).map((s, i) => (
                <div key={i} style={{ marginBottom: "var(--space-3)" }}>
                  <a href={s.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--info)", fontSize: "13px", display: "inline-flex", alignItems: "center", gap: "6px" }}>
                    <ExternalLink size={12} />
                    {s.title || s.url}
                  </a>
                  <span style={{ fontSize: "10px", color: "var(--text-3)", marginLeft: "8px", textTransform: "uppercase" }}>{s.type}</span>
                  {(s.key_points || []).length > 0 && (
                    <ul style={{ margin: "4px 0 0", paddingLeft: "20px" }}>
                      {s.key_points.map((k, ki) => (
                        <li key={ki} style={{ fontSize: "12px", color: "var(--text-2)" }}>{k}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </Card>
            <Card variant="flush" style={{ padding: "var(--space-5)" }}>
              <div style={{ ...monoLabel, marginBottom: "var(--space-3)" }}>Stats ({(research.stats || []).length})</div>
              {(research.stats || []).map((s, i) => (
                <div key={i} style={{ fontSize: "13px", color: "var(--text-1)", marginBottom: "var(--space-2)" }}>
                  {s.stat}{" "}
                  <a href={s.source_url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--info)", fontSize: "11px" }}>
                    source
                  </a>
                </div>
              ))}
              {(research.stats || []).length === 0 && (
                <div style={{ fontSize: "12px", color: "var(--text-3)" }}>No sourced stats — scrutinize the draft harder.</div>
              )}
            </Card>
            {(research.quotes || []).length > 0 && (
              <Card variant="flush" style={{ padding: "var(--space-5)" }}>
                <div style={{ ...monoLabel, marginBottom: "var(--space-3)" }}>Quotes</div>
                {research.quotes.map((q, i) => (
                  <blockquote key={i} style={{ borderLeft: "3px solid var(--accent)", paddingLeft: "var(--space-3)", margin: "0 0 var(--space-3)", fontSize: "13px", color: "var(--text-2)", fontStyle: "italic" }}>
                    “{q.quote}” — {q.attribution}{" "}
                    <a href={q.source_url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--info)", fontSize: "11px", fontStyle: "normal" }}>
                      source
                    </a>
                  </blockquote>
                ))}
              </Card>
            )}
            {(research.angles || []).length > 0 && (
              <Card variant="flush" style={{ padding: "var(--space-5)" }}>
                <div style={{ ...monoLabel, marginBottom: "var(--space-3)" }}>Angles</div>
                <ul style={{ paddingLeft: "20px" }}>
                  {research.angles.map((a, i) => (
                    <li key={i} style={{ fontSize: "13px", color: "var(--text-2)", marginBottom: "4px" }}>{a}</li>
                  ))}
                </ul>
              </Card>
            )}
            {(research.unsupported_subqueries || []).length > 0 && (
              <Card variant="flush" style={{ padding: "var(--space-5)", border: "1px solid var(--warn-border)" }}>
                <div style={{ ...monoLabel, color: "var(--warn)", marginBottom: "var(--space-3)" }}>Unsupported areas (no evidence found)</div>
                <ul style={{ paddingLeft: "20px" }}>
                  {research.unsupported_subqueries.map((u, i) => (
                    <li key={i} style={{ fontSize: "12px", color: "var(--warn)" }}>{u}</li>
                  ))}
                </ul>
              </Card>
            )}
          </div>
        )}

        {tab === "benchmark" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)", maxWidth: "760px" }}>
            {workOrder && (
              <Card variant="flush" style={{ padding: "var(--space-5)" }}>
                <div style={{ ...monoLabel, marginBottom: "var(--space-3)" }}>Work order</div>
                <div style={{ fontSize: "13px", color: "var(--text-1)", marginBottom: "var(--space-2)" }}>
                  <strong>Angle:</strong> {workOrder.angle}
                </div>
                {workOrder.hook_thesis && (
                  <div style={{ fontSize: "13px", color: "var(--text-1)", marginBottom: "var(--space-2)" }}>
                    <strong>Hook thesis:</strong> {workOrder.hook_thesis}
                  </div>
                )}
                {(workOrder.target_queries || []).length > 0 && (
                  <div style={{ fontSize: "12px", color: "var(--text-2)", marginBottom: "var(--space-2)" }}>
                    <strong>Target queries:</strong> {workOrder.target_queries.join(" · ")}
                  </div>
                )}
                {(workOrder.fan_out || []).length > 0 && (
                  <div style={{ fontSize: "12px", color: "var(--text-2)" }}>
                    <strong>Fan-out:</strong> {workOrder.fan_out.join(" · ")}
                  </div>
                )}
              </Card>
            )}
            <Card variant="flush" style={{ padding: "var(--space-5)" }}>
              <div style={{ ...monoLabel, marginBottom: "var(--space-3)" }}>
                {item.playbook === "geo_article" ? "Citation teardown" : "Channel pack"}
              </div>
              {item.playbook === "geo_article" ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
                  {benchmark.directive && (
                    <div style={{ fontSize: "13px", color: "var(--text-1)", background: "var(--accent-soft)", padding: "var(--space-3)", borderRadius: "var(--radius-1)" }}>
                      <strong>Directive:</strong> {benchmark.directive}
                    </div>
                  )}
                  {benchmark.format_distribution && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
                      {Object.entries(benchmark.format_distribution)
                        .filter(([, v]) => v > 0)
                        .sort((a, b) => b[1] - a[1])
                        .map(([fmt, pct]) => (
                          <Badge key={fmt} variant={fmt === benchmark.dominant_format ? "accent" : "neutral"}>
                            {fmt} {pct}%
                          </Badge>
                        ))}
                    </div>
                  )}
                  {benchmark.engine_divergence && (
                    <div style={{ fontSize: "12px", color: "var(--text-2)" }}>
                      <strong>Engine divergence:</strong> {benchmark.engine_divergence}
                    </div>
                  )}
                  {(benchmark.structural_notes || []).length > 0 && (
                    <ul style={{ paddingLeft: "20px" }}>
                      {benchmark.structural_notes.map((n, i) => (
                        <li key={i} style={{ fontSize: "12px", color: "var(--text-2)" }}>{n}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : (
                <pre style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--text-2)", whiteSpace: "pre-wrap", margin: 0 }}>
                  {JSON.stringify(benchmark.pack || benchmark, null, 2)}
                </pre>
              )}
            </Card>
          </div>
        )}

        {tab === "rubric" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)", maxWidth: "760px" }}>
            <Card variant="flush" style={{ padding: "var(--space-5)" }}>
              <div style={{ ...monoLabel, marginBottom: "var(--space-4)" }}>
                Per-dimension scores · weighted total {rubric.weighted_total ?? "—"} · verdict {rubric.verdict || "—"}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
                {Object.entries(rubric.scores || {}).map(([dim, score]) => (
                  <ScoreRow key={dim} dim={dim} score={score} />
                ))}
              </div>
            </Card>
            {(rubric.violations || []).length > 0 && (
              <Card variant="flush" style={{ padding: "var(--space-5)" }}>
                <div style={{ ...monoLabel, marginBottom: "var(--space-3)" }}>Violations</div>
                {(rubric.violations || []).map((v, i) => (
                  <div key={i} style={{ marginBottom: "var(--space-3)", display: "flex", gap: "var(--space-2)", alignItems: "flex-start" }}>
                    <Badge variant={v.ymyl ? "weak" : "moderate"}>{v.ymyl ? "YMYL" : v.rule}</Badge>
                    <span style={{ fontSize: "12px", color: "var(--text-2)", lineHeight: 1.5 }}>{v.detail}</span>
                  </div>
                ))}
              </Card>
            )}
            {rubric.critique && (
              <Card variant="flush" style={{ padding: "var(--space-5)" }}>
                <div style={{ ...monoLabel, marginBottom: "var(--space-3)" }}>Reviewer critique</div>
                <div style={{ fontSize: "13px", color: "var(--text-2)", whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{rubric.critique}</div>
              </Card>
            )}
          </div>
        )}

        {tab === "revisions" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)", maxWidth: "760px" }}>
            {(item.revisions || []).length === 0 && (
              <div style={{ padding: "var(--space-7)", textAlign: "center", fontSize: "13px", color: "var(--text-3)" }}>
                First draft — no prior revisions.
              </div>
            )}
            {[...(item.revisions || [])].reverse().map((rev, i) => (
              <Card key={i} variant="flush" style={{ padding: "var(--space-5)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
                  <Badge variant="muted">rev {rev.revision}</Badge>
                  {rev.source === "human_feedback" && <Badge variant="accent">human feedback</Badge>}
                  <span style={{ fontSize: "12px", color: "var(--text-2)" }}>{rev.title}</span>
                </div>
                {rev.critique && (
                  <div style={{ fontSize: "12px", color: "var(--warn)", marginBottom: "var(--space-3)", whiteSpace: "pre-wrap" }}>
                    Critique: {rev.critique}
                  </div>
                )}
                <details>
                  <summary style={{ fontSize: "11px", color: "var(--text-3)", cursor: "pointer" }}>Show draft</summary>
                  <div style={{ marginTop: "var(--space-3)" }}>
                    <Markdown>{rev.body_md}</Markdown>
                  </div>
                </details>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Decision bar */}
      {isAwaiting && (
        <div
          data-testid="studio-decision-bar"
          style={{
            flexShrink: 0,
            borderTop: "1px solid var(--border-1)",
            paddingTop: "var(--space-4)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-3)",
          }}
        >
          {error && (
            <div style={{ fontSize: "12px", color: "var(--crit)" }}>{error}</div>
          )}
          <textarea
            data-testid="studio-decision-comment"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Comment — required for request-changes / reject; every comment becomes a stored lesson for future drafts."
            rows={2}
            className="inp"
            aria-label="Review comment"
          />
          <div style={{ display: "flex", gap: "var(--space-3)" }}>
            <Button
              data-testid="studio-approve"
              variant="primary"
              size="md"
              onClick={() => decide("approved")}
              disabled={!!deciding}
            >
              {deciding === "approved" ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Check size={14} />}
              Approve
            </Button>
            <Button
              data-testid="studio-request-changes"
              variant="secondary"
              size="md"
              onClick={() => decide("changes_requested")}
              disabled={!!deciding}
            >
              {deciding === "changes_requested" ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <MessageSquareWarning size={14} />}
              Request changes
            </Button>
            <Button
              data-testid="studio-reject"
              variant="danger"
              size="md"
              onClick={() => decide("rejected")}
              disabled={!!deciding}
            >
              {deciding === "rejected" ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <X size={14} />}
              Reject
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
