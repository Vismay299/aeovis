"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, RefreshCw, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import { Card } from "@/components/perceev/Card";
import { Badge } from "@/components/perceev/Badge";
import { Skeleton } from "@/components/perceev/Skeleton";
import { KpiCard } from "@/components/perceev/KpiCard";
import { InlineAlert } from "@/components/app/InlineAlert";
import { SectionStrap } from "./SectionStrap";
import { extractBrandDomain } from "@/shared/scoring/citations";
import {
  describeCompareBudget,
  describePrimaryCrawlOutcome,
  describeRivalCrawlOutcome,
} from "@/shared/crawlabilityOutcome";

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

/**
 * T8 — the crawler files the live check read, as the inline alert's checks.
 * Every row is the response's own field; a file that is absent or was not
 * checked is never drawn as a pass.
 */
function crawlChecks(data) {
  let robots;
  if (!data.fetched_ok || data.robots_txt_status === "error") {
    robots = { ok: false, status: "Couldn't read" };
  } else if (data.robots_txt_status === "missing") {
    robots = { ok: null, status: "Not found" };
  } else if (data.robots_malformed) {
    robots = { ok: false, status: "Couldn't fully parse" };
  } else {
    robots = { ok: true, status: "Read" };
  }
  let llms;
  if (data.llms_txt_present === true) llms = { ok: true, status: "Found" };
  else if (data.llms_txt_present === false) llms = { ok: null, status: "Not found" };
  else llms = { ok: null, status: "Not checked" };
  return [
    { name: "robots.txt", ...robots },
    { name: "llms.txt", ...llms },
  ];
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

  // T8: a retry from an alert re-runs the same live check but keeps what is on
  // screen, so the alert itself can show it is checking until the real answer
  // replaces it. Nothing here decides a result; the response does.
  const [rechecking, setRechecking] = useState(false);

  const fetchAudit = useCallback(
    async (path, { keep = false } = {}) => {
      if (!brand) {
        setData(null);
        setErrorMessage(
          "No website domain is on file for this brand yet — run a scan with a website URL to audit crawlability."
        );
        return;
      }
      if (keep) {
        setRechecking(true);
      } else {
        setData(undefined);
        setErrorMessage(null);
      }
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
        setErrorMessage(null);
        setData(json);
      } catch {
        setData(null);
        setErrorMessage("Network error while auditing crawlability. Check your connection and retry.");
      } finally {
        if (keep) setRechecking(false);
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

  // R3.7.7: the route audits at most MAX_COMPARE_DOMAINS rivals and a refused
  // domain spends one of those slots, so asking about six can return four
  // scored rows. Rendering the short list without a word is the same empty-
  // state-as-clean-state bug this task exists to fix, so the gap between what
  // we asked for and what came back is stated explicitly.
  const compareBudget = useMemo(
    () =>
      data
        ? describeCompareBudget({
            requested: rivalDomains,
            compared: data.compare,
            primaryDomain: data.domain || brand,
          })
        : null,
    [data, rivalDomains, brand]
  );

  // R3.7.8: the reason the brand's OWN robots.txt was not read. A typo in their
  // domain and a network fault we own are different facts and must not share a
  // banner; the words live in describePrimaryCrawlOutcome so the suite can run
  // them. Returns null when the fetch succeeded, so the banner's existence is
  // decided by the derivation rather than by a second reading of fetched_ok.
  const primaryOutcome = useMemo(() => (data ? describePrimaryCrawlOutcome(data) : null), [data]);

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
        <InlineAlert
          data-testid="crawlability-error"
          tone="error"
          icon={ShieldAlert}
          title="Couldn't audit crawlability"
          message={errorMessage || "Something went wrong while auditing this domain."}
          // Retry re-runs the live GET /api/brands/[brand]/crawlability.
          onRetry={brand ? () => fetchAudit(activePath, { keep: true }) : undefined}
          retrying={rechecking}
          retryLabel="Retry"
        />
      )}

      {/* Ready */}
      {data && (
        <>
          {/* Verdict strap headline — Peec's framing */}
          <div
            style={{
              background: "var(--bg-1)",
              borderTop: "3px solid var(--brand)",
              borderRight: "1px solid var(--border-1)",
              borderBottom: "1px solid var(--border-1)",
              borderLeft: "1px solid var(--border-1)",
              borderRadius: "var(--radius-2)",
              padding: "var(--space-7)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginBottom: "var(--space-3)" }}>
              <Bot size={18} style={{ color: "var(--brand)" }} />
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
          {/* The testid names the SURFACE, not one of its states: the old
              "crawlability-unreachable" asserted a network problem on a banner
              that now also carries "your domain does not resolve". Nothing
              outside this component selected it. */}
          {primaryOutcome && (
            <InlineAlert
              tone={primaryOutcome.tone === "crit" ? "error" : "warning"}
              icon={primaryOutcome.actionable === "you" ? ShieldAlert : ShieldQuestion}
              data-testid="crawlability-primary-outcome"
              data-outcome={primaryOutcome.kind}
              data-actionable={primaryOutcome.actionable}
              title={primaryOutcome.label}
              message={primaryOutcome.detail}
              checks={crawlChecks(data)}
              // Re-runs the live check; the checks show what it returns.
              onRetry={() => fetchAudit(activePath, { keep: true })}
              retrying={rechecking}
              retryLabel="Check again"
            />
          )}
          {data.fetched_ok && data.robots_txt_status === "missing" && (
            <InlineAlert
              tone="info"
              title={`No robots.txt found on ${data.domain} — nothing restricts AI crawlers there by default.`}
            />
          )}
          {data.robots_malformed && (
            <InlineAlert
              tone="warning"
              title={`robots.txt on ${data.domain} couldn't be fully parsed — results default to open and are unverified.`}
            />
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
                  onFocus={(e) => (e.target.style.borderColor = "var(--brand)")}
                  onBlur={(e) => (e.target.style.borderColor = "var(--border-2)")}
                />
              </div>
              <button
                type="submit"
                style={{
                  background: "var(--brand)",
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
                <RivalCrawlRow label={data.domain} isYou summary={data.summary} row={data} />
                {(data.compare || []).map((r) => (
                  <RivalCrawlRow key={r.domain} label={r.domain} summary={r.summary} row={r} />
                ))}
                {compareBudget && (
                  <p
                    data-testid="crawlability-compare-budget"
                    style={{
                      marginTop: "var(--space-2)",
                      fontSize: "12px",
                      lineHeight: 1.5,
                      color: "var(--text-3)",
                      borderLeft: "2px solid var(--border-2)",
                      paddingLeft: "var(--space-3)",
                    }}
                  >
                    {compareBudget.message}
                  </p>
                )}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
};

const OUTCOME_TONE = {
  crit: "var(--crit)",
  warn: "var(--warn)",
  muted: "var(--text-3)",
};

/**
 * One rival's crawlability, or — when there is no audit — the reason there
 * isn't one.
 *
 * `row` is the whole compare row (or the primary payload for the "you" line),
 * not just `fetched_ok`: the three failure states R3.7.4 made distinguishable
 * live in `blocked` and `fetch_error`, and reading only `fetched_ok` is what
 * collapsed a security refusal, a dead domain and a timeout into one
 * "Unreachable" line. The wording itself is in describeRivalCrawlOutcome so
 * the suite can execute it.
 */
function RivalCrawlRow({ label, isYou, summary, row }) {
  const total = summary?.total || 0;
  const open = summary?.open || 0;
  const partial = summary?.partial || 0;
  const blocked = summary?.blocked || 0;
  const openPct = total > 0 ? Math.round((open / total) * 100) : 0;
  const outcome = describeRivalCrawlOutcome(row);

  return (
    <div
      data-testid={`crawlability-rival-${label}`}
      data-outcome={outcome ? outcome.kind : "audited"}
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

      {outcome ? (
        <span
          data-testid={`crawlability-rival-outcome-${label}`}
          style={{ flex: 1, fontSize: "12px", lineHeight: 1.4, color: OUTCOME_TONE[outcome.tone] || "var(--text-3)" }}
        >
          {/* No dash separator: several labels already carry an em dash, and
              two in one line reads as a typo. */}
          <strong style={{ fontWeight: 600 }}>{outcome.label}</strong>
          <span style={{ color: "var(--text-3)" }}>. {outcome.detail}</span>
        </span>
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
