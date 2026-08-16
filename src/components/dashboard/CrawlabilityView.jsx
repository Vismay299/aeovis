"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, RefreshCw, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import { Card } from "@/components/perceev/Card";
import { Badge } from "@/components/perceev/Badge";
import { Alert } from "@/components/perceev/Alert";
import { Skeleton } from "@/components/perceev/Skeleton";
import { KpiCard } from "@/components/perceev/KpiCard";
import { SectionStrap } from "./SectionStrap";
import { extractBrandDomain } from "@/lib/scoring/citations";

const STATUS_META = {
  open: { label: "Open", badgeVariant: "strong" },
  partial: { label: "Partial", badgeVariant: "moderate" },
  blocked: { label: "Blocked", badgeVariant: "weak" },
};

const PURPOSE_LABELS = { training: "Training", search: "Search", agent: "Agent" };

const PURPOSE_FILTERS = ["all", "training", "search", "agent"];
const STATUS_FILTERS = ["all", "open", "partial", "blocked"];

/**
 * Best-effort domain extraction from a tracked competitor entry. Most
 * competitors on a scan are plain brand names ("Acme Corp"), not URLs — only
 * ones that already look like a hostname (contains a dot, no spaces) are
 * treated as a domain. Everything else is silently skipped rather than
 * guessed at (see CrawlabilityView's "rivals need domains" empty state).
 */
function deriveRivalDomains(competitors) {
  if (!Array.isArray(competitors)) return [];
  const seen = new Set();
  const out = [];
  for (const c of competitors) {
    const raw = String((typeof c === "string" ? c : c?.name || c?.url || c?.website) || "").trim();
    if (!raw || /\s/.test(raw)) continue;
    if (!/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(raw)) continue;
    const domain = extractBrandDomain(raw);
    if (domain && !seen.has(domain)) {
      seen.add(domain);
      out.push(domain);
    }
  }
  return out;
}

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || { label: status || "Unknown", badgeVariant: "neutral" };
  return <Badge variant={meta.badgeVariant}>{meta.label}</Badge>;
}

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
      }}
    >
      {children}
    </button>
  );
}

export const CrawlabilityView = ({ brand, competitors }) => {
  const rivalDomains = useMemo(() => deriveRivalDomains(competitors), [competitors]);

  const [testPathInput, setTestPathInput] = useState("/");
  const [activePath, setActivePath] = useState("/");
  const [data, setData] = useState(undefined); // undefined = loading, null = fatal error, object = ready
  const [errorMessage, setErrorMessage] = useState(null);
  const [purposeFilter, setPurposeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");

  const fetchAudit = useCallback(
    async (path) => {
      if (!brand) {
        setData(null);
        setErrorMessage(
          "No website domain is on file for this brand yet — run a scan with a website URL to audit crawlability."
        );
        return;
      }
      setData(undefined);
      setErrorMessage(null);
      try {
        const params = new URLSearchParams({ url: path || "/" });
        if (rivalDomains.length) params.set("compare", rivalDomains.join(","));
        const res = await fetch(`/api/brands/${encodeURIComponent(brand)}/crawlability?${params.toString()}`, {
          cache: "no-store",
        });
        const json = await res.json().catch(() => null);
        if (!res.ok) {
          setData(null);
          setErrorMessage(json?.error || "Failed to audit crawlability.");
          return;
        }
        setData(json);
      } catch {
        setData(null);
        setErrorMessage("Network error while auditing crawlability. Check your connection and retry.");
      }
    },
    [brand, rivalDomains]
  );

  useEffect(() => {
    fetchAudit(activePath);
  }, [fetchAudit, activePath]);

  const handleTestSubmit = (e) => {
    e.preventDefault();
    const next = testPathInput.trim() || "/";
    setActivePath(next.startsWith("/") ? next : `/${next}`);
  };

  const filteredBots = useMemo(() => {
    const bots = data?.bots || [];
    return bots.filter((b) => {
      if (purposeFilter !== "all" && b.purpose !== purposeFilter) return false;
      if (statusFilter !== "all" && b.status !== statusFilter) return false;
      return true;
    });
  }, [data, purposeFilter, statusFilter]);

  return (
    <div data-testid="crawlability-view" style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
      <SectionStrap testId="crawlability-strap">Crawlability</SectionStrap>

      {/* Loading */}
      {data === undefined && (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
          <Skeleton style={{ height: "96px", borderRadius: "var(--radius-2)" }} />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "var(--space-5)" }}>
            <Skeleton style={{ height: "110px" }} />
            <Skeleton style={{ height: "110px" }} />
            <Skeleton style={{ height: "110px" }} />
          </div>
          <Skeleton style={{ height: "320px" }} />
        </div>
      )}

      {/* Fatal error — no domain to audit, or the request itself failed */}
      {data === null && (
        <Alert
          data-testid="crawlability-error"
          variant="crit"
          title={
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
              <ShieldAlert size={16} />
              Couldn&apos;t audit crawlability
            </div>
          }
          action={
            brand ? (
              <button
                type="button"
                onClick={() => fetchAudit(activePath)}
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
          {errorMessage || "Something went wrong while auditing this domain."}
        </Alert>
      )}

      {/* Ready */}
      {data && (
        <>
          {/* Verdict strap headline — Peec's framing */}
          <div
            style={{
              background: "var(--bg-1)",
              borderTop: "3px solid var(--accent)",
              borderRight: "1px solid var(--border-1)",
              borderBottom: "1px solid var(--border-1)",
              borderLeft: "1px solid var(--border-1)",
              borderRadius: "var(--radius-2)",
              padding: "var(--space-7)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginBottom: "var(--space-3)" }}>
              <Bot size={18} style={{ color: "var(--accent)" }} />
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "10px",
                  fontWeight: 500,
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  color: "var(--text-3)",
                }}
              >
                AI crawler access audit
              </span>
              {data.llms_txt_present && (
                <span
                  style={{
                    marginLeft: "auto",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                    fontFamily: "var(--font-mono)",
                    fontSize: "9px",
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    color: "var(--good)",
                    background: "var(--good-bg)",
                    border: "1px solid var(--good-border)",
                    borderRadius: "var(--radius-round)",
                    padding: "3px 9px",
                  }}
                >
                  <ShieldCheck size={11} />
                  llms.txt found
                </span>
              )}
            </div>
            <p
              data-testid="crawlability-verdict"
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: "22px",
                fontWeight: 600,
                lineHeight: 1.35,
                letterSpacing: "-0.01em",
                color: "var(--text-1)",
              }}
            >
              <strong style={{ color: "var(--you)", fontWeight: 700 }}>{data.domain}</strong> —{" "}
              <strong style={{ fontWeight: 700 }}>
                {data.summary?.blocked ?? 0} of {data.summary?.total ?? 0}
              </strong>{" "}
              AI crawlers restricted, <strong style={{ fontWeight: 700 }}>{data.summary?.open ?? 0}</strong> fully
              open.
            </p>
            {activePath !== "/" && (
              <p style={{ marginTop: "var(--space-2)", fontSize: "12px", color: "var(--text-3)" }}>
                Tested against <span style={{ fontFamily: "var(--font-mono)" }}>{activePath}</span>, not the site root.
              </p>
            )}
          </div>

          {/* Reliability banners — never silently hide a degraded read */}
          {!data.fetched_ok && (
            <Alert variant="warn" data-testid="crawlability-unreachable">
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                <ShieldQuestion size={16} />
                Couldn&apos;t reach {data.domain}/robots.txt
                {data.fetch_error ? ` (${data.fetch_error.replace(/_/g, " ")})` : ""} — showing every crawler as
                default-open, unverified.
              </div>
            </Alert>
          )}
          {data.fetched_ok && data.robots_txt_status === "missing" && (
            <Alert variant="info">
              No robots.txt found on {data.domain} — nothing restricts AI crawlers there by default.
            </Alert>
          )}
          {data.robots_malformed && (
            <Alert variant="warn">
              robots.txt on {data.domain} couldn&apos;t be fully parsed — results default to open and are unverified.
            </Alert>
          )}

          {/* Summary tiles */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "var(--space-5)" }}>
            <KpiCard testId="crawlability-open-count" label="Open" value={data.summary?.open ?? 0} tone="good" sub="Full access, no restrictions" />
            <KpiCard testId="crawlability-partial-count" label="Partial" value={data.summary?.partial ?? 0} tone="warn" sub="Allowed here, restricted elsewhere" />
            <KpiCard testId="crawlability-blocked-count" label="Blocked" value={data.summary?.blocked ?? 0} tone="crit" sub="Disallowed for the tested path" />
          </div>

          {/* URL tester */}
          <Card>
            <form
              data-testid="crawlability-url-tester"
              onSubmit={handleTestSubmit}
              style={{ display: "flex", alignItems: "flex-end", gap: "var(--space-4)", flexWrap: "wrap" }}
            >
              <div style={{ flex: "1 1 260px", minWidth: "220px" }}>
                <label
                  style={{
                    display: "block",
                    fontFamily: "var(--font-mono)",
                    fontSize: "9px",
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.1em",
                    color: "var(--text-2)",
                    marginBottom: "var(--space-2)",
                  }}
                >
                  Test a specific path
                </label>
                <input
                  type="text"
                  value={testPathInput}
                  onChange={(e) => setTestPathInput(e.target.value)}
                  placeholder="/blog/some-article"
                  style={{
                    width: "100%",
                    background: "var(--bg-0)",
                    border: "1px solid var(--border-2)",
                    borderRadius: "var(--radius-1)",
                    padding: "9px 12px",
                    fontFamily: "var(--font-mono)",
                    fontSize: "13px",
                    color: "var(--text-1)",
                    outline: "none",
                    boxSizing: "border-box",
                  }}
                  onFocus={(e) => (e.target.style.borderColor = "var(--accent)")}
                  onBlur={(e) => (e.target.style.borderColor = "var(--border-2)")}
                />
              </div>
              <button
                type="submit"
                style={{
                  background: "var(--accent)",
                  color: "var(--accent-fg)",
                  border: "none",
                  borderRadius: "var(--radius-1)",
                  padding: "10px 18px",
                  fontFamily: "var(--font-display)",
                  fontSize: "12px",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  cursor: "pointer",
                  minHeight: "var(--control-h-md)",
                }}
              >
                Test path
              </button>
              <button
                type="button"
                title="Re-run this audit"
                onClick={() => fetchAudit(activePath)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  background: "transparent",
                  color: "var(--text-2)",
                  border: "1px solid var(--border-2)",
                  borderRadius: "var(--radius-1)",
                  padding: "10px 14px",
                  fontFamily: "var(--font-display)",
                  fontSize: "12px",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  cursor: "pointer",
                  minHeight: "var(--control-h-md)",
                }}
              >
                <RefreshCw size={12} />
                Refresh
              </button>
            </form>
          </Card>

          {/* Filters */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-5)", alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "var(--text-3)", marginRight: "2px" }}>
                Purpose
              </span>
              {PURPOSE_FILTERS.map((p) => (
                <FilterPill
                  key={p}
                  testId={`crawlability-filter-purpose-${p}`}
                  active={purposeFilter === p}
                  onClick={() => setPurposeFilter(p)}
                >
                  {p === "all" ? "All" : PURPOSE_LABELS[p] || p}
                </FilterPill>
              ))}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "var(--text-3)", marginRight: "2px" }}>
                Status
              </span>
              {STATUS_FILTERS.map((s) => (
                <FilterPill
                  key={s}
                  testId={`crawlability-filter-status-${s}`}
                  active={statusFilter === s}
                  onClick={() => setStatusFilter(s)}
                >
                  {s === "all" ? "All" : STATUS_META[s]?.label || s}
                </FilterPill>
              ))}
            </div>
          </div>

          {/* Bot table */}
          <Card variant="flush" data-testid="crawlability-table">
            {/* Five columns of bot detail cannot fit a phone. Wide content
                scrolls inside its own container; the page body never does. */}
            <div className="panel__b--scroll">
            <div style={{ minWidth: 640 }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1.6fr 1fr 0.9fr 0.9fr 2fr",
                gap: "var(--space-4)",
                padding: "var(--space-4) var(--space-6)",
                borderBottom: "1px solid var(--border-1)",
                fontFamily: "var(--font-mono)",
                fontSize: "9px",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                color: "var(--text-3)",
              }}
            >
              <span>Bot</span>
              <span>Operator</span>
              <span>Purpose</span>
              <span>Status</span>
              <span>Why</span>
            </div>
            {filteredBots.length === 0 ? (
              <div style={{ padding: "var(--space-10)", textAlign: "center", fontSize: "13px", color: "var(--text-3)" }}>
                No crawlers match the current filters.
              </div>
            ) : (
              filteredBots.map((bot, i) => (
                <div
                  key={bot.name}
                  data-testid={`crawlability-row-${bot.name}`}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1.6fr 1fr 0.9fr 0.9fr 2fr",
                    gap: "var(--space-4)",
                    padding: "var(--space-4) var(--space-6)",
                    borderBottom: i < filteredBots.length - 1 ? "1px solid var(--border-1)" : "none",
                    alignItems: "center",
                  }}
                >
                  <div>
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: "13px", fontWeight: 600, color: "var(--text-1)" }}>
                      {bot.name}
                    </div>
                    <div style={{ fontSize: "11px", color: "var(--text-3)", marginTop: "2px" }}>{bot.platform}</div>
                  </div>
                  <div style={{ fontSize: "13px", color: "var(--text-2)" }}>{bot.operator}</div>
                  <div>
                    <Badge variant="neutral">{PURPOSE_LABELS[bot.purpose] || bot.purpose}</Badge>
                  </div>
                  <div>
                    <StatusBadge status={bot.status} />
                  </div>
                  <div style={{ fontSize: "12px", color: "var(--text-3)", lineHeight: 1.4 }}>
                    {bot.reason}
                    {bot.unknown && (
                      <span style={{ color: "var(--warn)", marginLeft: "6px", fontWeight: 600 }}>(unverified)</span>
                    )}
                  </div>
                </div>
              ))
            )}
            </div>
            </div>
          </Card>

          {/* Rival comparison */}
          <Card>
            <h3
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: "var(--type-h3)",
                fontWeight: 600,
                color: "var(--text-1)",
                letterSpacing: "var(--track-h3)",
                marginBottom: "var(--space-4)",
              }}
            >
              Rival crawlability
            </h3>
            {rivalDomains.length === 0 ? (
              <p style={{ fontSize: "13px", color: "var(--text-3)" }}>
                Rival comparison needs a domain for each tracked competitor — none of your tracked competitors have
                one on file yet.
              </p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
                {/* You, first, for a fixed reference point */}
                <RivalCrawlRow label={data.domain} isYou summary={data.summary} fetchedOk={data.fetched_ok} />
                {(data.compare || []).map((r) => (
                  <RivalCrawlRow key={r.domain} label={r.domain} summary={r.summary} fetchedOk={r.fetched_ok} />
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
};

function RivalCrawlRow({ label, isYou, summary, fetchedOk }) {
  const total = summary?.total || 0;
  const open = summary?.open || 0;
  const partial = summary?.partial || 0;
  const blocked = summary?.blocked || 0;
  const openPct = total > 0 ? Math.round((open / total) * 100) : 0;

  return (
    <div
      data-testid={`crawlability-rival-${label}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-4)",
        padding: "var(--space-3) var(--space-4)",
        borderRadius: "var(--radius-1)",
        background: isYou ? "var(--you-soft)" : "var(--bg-0)",
        border: `1px solid ${isYou ? "var(--you-border)" : "var(--border-1)"}`,
      }}
    >
      <div style={{ minWidth: "160px", flexShrink: 0 }}>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "12px",
            fontWeight: 600,
            color: isYou ? "var(--you)" : "var(--text-1)",
          }}
        >
          {label}
        </span>
        {isYou && (
          <span
            style={{
              marginLeft: "6px",
              fontFamily: "var(--font-mono)",
              fontSize: "9px",
              color: "var(--you)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            you
          </span>
        )}
      </div>

      {!fetchedOk ? (
        <span style={{ fontSize: "12px", color: "var(--warn)" }}>Unreachable — treated as fully open, unverified</span>
      ) : (
        <>
          <div
            style={{
              flex: 1,
              height: "8px",
              borderRadius: "var(--radius-round)",
              background: "var(--meter-track)",
              overflow: "hidden",
              display: "flex",
            }}
          >
            <div style={{ width: `${openPct}%`, background: "var(--good)" }} />
            <div style={{ width: `${total > 0 ? Math.round((partial / total) * 100) : 0}%`, background: "var(--warn)" }} />
            <div style={{ width: `${total > 0 ? Math.round((blocked / total) * 100) : 0}%`, background: "var(--crit)" }} />
          </div>
          <div style={{ display: "flex", gap: "var(--space-3)", fontSize: "11px", color: "var(--text-2)", flexShrink: 0 }}>
            <span style={{ color: "var(--good)" }}>{open} open</span>
            <span style={{ color: "var(--warn)" }}>{partial} partial</span>
            <span style={{ color: "var(--crit)" }}>{blocked} blocked</span>
          </div>
        </>
      )}
    </div>
  );
}
