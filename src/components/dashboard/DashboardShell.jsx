"use client";

import React, { useEffect, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, FlaskConical, Loader2, Download, ShieldAlert } from "lucide-react";
import { Sidebar } from "@/components/perceev/Sidebar";
import { ScoreBand } from "@/components/dashboard/ScoreBand";
import { ProvenanceStrip } from "@/components/dashboard/ProvenanceStrip";
import { OverviewView } from "@/components/dashboard/OverviewView";
import { AnswersView } from "@/components/dashboard/AnswersView";
import { RivalsView } from "@/components/dashboard/RivalsView";
import { SourcesView } from "@/components/dashboard/SourcesView";
import { QueriesView } from "@/components/dashboard/QueriesView";
import { CrawlabilityView } from "@/components/dashboard/CrawlabilityView";
import { StudioView } from "@/components/studio/StudioView";
import {
  fetchScanHistory,
  normalizeResult,
  getHistoryNonBrandedCount,
} from "@/services/api";
import { scoreTier, formatTimestamp, relativeTime, hasTimestamp, formatCollectionWindow } from "@/utils/format";
import { getBrandAliases } from "@/lib/scoring/aliases";
import { resolveBrandKey } from "@/lib/scoring/brandKey";
import {
  AIO_ERROR_RATE_LIMIT_PCT,
  AIO_MIN_NON_BRANDED_COVERAGE,
} from "@/lib/scoring/aioConstants";
/**
 * KNOWN COST, NOT A SECRET: this is a client component, and enginePipeline.js
 * also imports the probe modules (brightdata/openai/perplexity) and, through
 * judge.js, src/lib/gemini.js. package.json declares no `sideEffects`, so
 * webpack keeps those modules in the dashboard client bundle even though only
 * describeScanDataSourceIssue is used here — @google/generative-ai ships to the
 * browser as a result. Nothing leaks (Next inlines only NEXT_PUBLIC_* env, so
 * no key is in the bundle) and nothing breaks; it is weight. The fix is to lift
 * describeScanDataSourceIssue + engineHealthThresholds into a leaf module that
 * imports only aioConstants and deployedEngines, which is a file R2.2.6 was
 * scoped not to create. Written down rather than left for someone to discover
 * in a bundle report.
 */
import { describeScanDataSourceIssue } from "@/lib/scoring/enginePipeline";
/**
 * R2.1.1 — kept as a SECOND import from the same module rather than folded into
 * the line above, deliberately: degradedEngineBanner.test.mjs guards that exact
 * import statement by regex, and widening it would break a sibling task's proof
 * that this component defers to the pipeline for its degradation wording.
 */
import { describeScanMeasurement } from "@/lib/scoring/enginePipeline";

/**
 * R2.1.1 — the hero trend, or NOTHING and why.
 *
 * The previous hero score was read as `... ?? prev.visibility_pct ?? 0`. With a
 * nullable score that default is a claim: it says the last reading WAS zero, so
 * the band reports a climb of the entire current score that never happened.
 *
 * Exported for src/components/dashboard/historyScoreSurface.test.mjs — this
 * file is JSX and the test runner is bare `node --test`, so the logic that must
 * be proven lives outside the markup.
 */
export function describeHeroTrend(currentHero, prev) {
  // The previous HERO score, which for a multi-engine scan is the blended index
  // in raw_results and otherwise the aio column. Note the missing `?? 0` — that
  // default is the bug, and there is no honest number to put in its place.
  //
  // A finite check rather than describeScanMeasurement: `visibility_index_pct`
  // is computeHeadline's output over the slices that WERE measured, so it has
  // no per-engine state of its own to consult, and the `visibility_pct` arm is
  // the same nullable column the history cards read. Absent is absent either way.
  const hasQualifiedContract = prev?.summary_stats?.metric_contract_version || prev?.raw_results?.summary_stats?.metric_contract_version;
  const prevHero = hasQualifiedContract ? describeScanMeasurement(prev).pct
    : (prev?.raw_results?.visibility_index_pct ?? prev?.visibility_pct ?? null);
  if (!Number.isFinite(currentHero) || !Number.isFinite(prevHero)) {
    return {
      trend: null,
      unavailable: Number.isFinite(currentHero)
        ? "The previous reading has no score, so there is no change to show."
        : "This reading has no score, so there is no change to show.",
    };
  }
  return { trend: (currentHero - prevHero).toFixed(1), unavailable: null };
}

/**
 * R2.1.1 — the delta between two stored readings, or NOTHING and why.
 *
 * This shipped as `(next.visibility_pct - (s.visibility_pct || 0)).toFixed(1)`.
 * Now that an engine which measured nothing publishes null instead of 0, that
 * expression is the worst kind of broken: `null - 40` is `-40` and `50 - null`
 * is `50`, so it produces a confident, WRONG number rather than a NaN anybody
 * would notice. The `|| 0` was the same lie one operator earlier — it turned a
 * missing score into "you were at zero and you have climbed".
 *
 * A delta needs a real number on BOTH ends. When it does not have one there is
 * no number to show and the card says so, because a silently missing delta and
 * a genuinely flat one are different facts (standing rule 1).
 */
export function describeHistoryDelta(later, earlier) {
  if (!later) {
    // The newest card has nothing after it. Not a suppression: there is simply
    // no later reading, which is why this reason is distinct from the one below.
    return { value: null, delta: null, reason: "no_later_reading", detail: null };
  }
  const a = describeScanMeasurement(later);
  const b = describeScanMeasurement(earlier);
  if (!a.measured || !b.measured) {
    return {
      value: null,
      delta: null,
      reason: "unmeasured_endpoint",
      detail: !b.measured
        ? "No change shown — this reading has no score to compare."
        : "No change shown — the reading after this one has no score to compare.",
    };
  }
  const delta = a.pct - b.pct;
  return { value: delta.toFixed(1), delta, reason: null, detail: null };
}

/**
 * R2.7.3 (finding C1) — two records match only when BOTH carry a real instant.
 *
 * `scanTimestamp` is now null when a record has no collection time, and
 * `new Date(null).getTime()` is 0, not NaN. Comparing raw getTime() values would
 * make every unstamped record collide at the epoch and light up an unrelated
 * history card as "active". Missing is never equal to missing.
 */
function sameInstant(a, b) {
  if (!hasTimestamp(a) || !hasTimestamp(b)) return false;
  return new Date(a).getTime() === new Date(b).getTime();
}

const RERUN_STAGES = [
  "Submitting brand for analysis",
  "Sourcing real buyer queries",
  "Probing the answer engines",
  "Scoring visibility & composing evidence",
];

const VIEW_TITLE = {
  overview: "Overview",
  answers: "Answers",
  rivals: "Rivals",
  sources: "Sources",
  queries: "Tracked queries",
  crawlability: "Crawlability",
  studio: "Studio",
};

/* Engines are configured per deployment, so every engine-facing label is
   derived from what the scan actually reported — never a fixed list. */
const ENGINE_LABEL = {
  aio: "AI Overview",
  google_ai_overview: "AI Overview",
  chatgpt: "ChatGPT",
  openai: "ChatGPT",
  perplexity: "Perplexity",
  gemini: "Gemini",
};

function engineLabel(key) {
  return ENGINE_LABEL[key] || String(key || "").toUpperCase();
}

/**
 * DashboardShell.
 *
 * The whole product surface: one app shell with a real sidebar and an inner
 * view router, so the five reading views and Studio share the same chrome.
 *
 * Props:
 *   scan   — the raw scan record to display, in a three-state contract:
 *              undefined -> still loading (skeleton)
 *              null      -> nothing to show (empty state)
 *              object    -> a scan record (DB row shape or a sample record);
 *                           normalized internally via normalizeResult()
 *   scanId — optional, the concrete `scans.id` of the record being shown.
 *            Reserved for a future precise "view this exact scan" deep link.
 */
export default function DashboardShell({ scan, scanId, error = null }) {
  const router = useRouter();
  const [result, setResult] = useState(undefined);
  const [history, setHistory] = useState([]);
  const [isScanning, setIsScanning] = useState(false);
  const [scanError, setScanError] = useState(null);
  const [rerunStage, setRerunStage] = useState(0);
  const [rerunProgress, setRerunProgress] = useState(0);
  const [view, setView] = useState("overview");
  const [studioBadge, setStudioBadge] = useState(0);
  const [studioNotice, setStudioNotice] = useState(null);
  const [studioInitialItem, setStudioInitialItem] = useState(null);

  // Deep-link support: /dashboard/[brand]?view=studio&item=<id> lands directly
  // on a run from the homepage workspace. Read once from the URL on mount.
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const v = params.get("view");
      const validViews = ["overview", "answers", "rivals", "sources", "queries", "crawlability", "studio"];
      if (v && validViews.includes(v)) setView(v);
      const item = params.get("item");
      if (item) setStudioInitialItem(item);
    } catch {
      /* no-op */
    }
  }, []);

  // `scan` is supplied by the route: undefined while loading, null when there
  // is nothing to show, or the raw record (DB row or sample) once available.
  useEffect(() => {
    const normalized = scan
      ? normalizeResult(scan, scan.brand, scan.website)
      : scan;
    setResult(normalized);
    if (normalized && normalized.brand && !normalized.isSample) {
      fetchScanHistory(normalized.brand).then((scans) => setHistory(scans || []));
    }
  }, [scan]);

  // Studio badge: count of items awaiting human approval for this brand.
  useEffect(() => {
    const brand = result?.brand;
    if (!brand || result?.isSample) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/content-items?brand=${encodeURIComponent(brand)}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) {
          setStudioBadge(
            (data.items || []).filter((i) => i.status === "awaiting_approval").length
          );
        }
      } catch {
        /* badge is best-effort */
      }
    };
    poll();
    const t = setInterval(poll, 15000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [result?.brand, result?.isSample]);

  // AnswersView gap-row trigger: prefilled geo_article job — the AI's current
  // answer and citations ride along as input.
  const handleGenerateContent = async (row) => {
    try {
      const res = await fetch("/api/content", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brand: result.brand,
          playbook: "geo_article",
          input: {
            type: "gap",
            query: row.prompt,
            engine: row.engine || "aio",
            gap_kind: row.visible ? "rank_not_cited" : "absent",
            answer_text: row.aioText || "",
            citations: (row.aioReferences || []).map((r) => ({ href: r.href, title: r.title || "" })),
            topic: row.topic || undefined,
            brand_profile: "healthcare-cxo",
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Failed to start content job");
      setStudioNotice(null);
      setView("studio");
    } catch (e) {
      setStudioNotice(e.message);
      setView("studio");
    }
  };

  const { scoreTrend, trendUnavailable, previousScan, sortedHistory, deltaSamePromptSet } = useMemo(() => {
    let scoreTrend = null;
    // Why there is no trend, when the reason is a missing score rather than the
    // ordinary "this is the first reading". Null when nothing was suppressed.
    let trendUnavailable = null;
    let previousScan = null;
    let sortedHistory = [];
    let deltaSamePromptSet = true;
    if (!result || !history?.length) {
      return { scoreTrend, trendUnavailable, previousScan, sortedHistory, deltaSamePromptSet };
    }

    sortedHistory = [...history].sort(
      (a, b) => new Date(b.scanned_at) - new Date(a.scanned_at)
    );
    const idx = sortedHistory.findIndex((s) => sameInstant(s.scanned_at, result.scanTimestamp));
    let prev = null;

    if (idx !== -1 && idx + 1 < sortedHistory.length) {
      // Find the most recent previous scan with the same prompt_set_id
      for (let j = idx + 1; j < sortedHistory.length; j++) {
        const candidate = sortedHistory[j];
        const candidatePromptSetId = candidate.prompt_set_id || "";
        const currentPromptSetId = result.promptSetId || result.prompt_set_id || "";
        const candidateScoringMajor = (candidate.scoring_version || "").split("-")[0] || "";
        const currentScoringMajor = (result.scoringVersion || "").split("-")[0] || "";

        if (candidatePromptSetId && currentPromptSetId && candidatePromptSetId === currentPromptSetId) {
          prev = candidate;
          break;
        }
        // Same scoring major version — also acceptable
        if (candidateScoringMajor === currentScoringMajor && candidatePromptSetId === currentPromptSetId) {
          prev = candidate;
          break;
        }
      }

      // If no matching prompt set found, mark as new prompt set
      if (!prev) {
        prev = sortedHistory[idx + 1]; // fallback for display purposes
        deltaSamePromptSet = false;
      }
    } else if (idx === -1 && sortedHistory.length > 0) {
      prev = sortedHistory[0];
      deltaSamePromptSet = false;
    }

    if (prev && deltaSamePromptSet) {
      // Compare hero-to-hero: multi-engine scans display the visibility index,
      // so the delta must use the index on both sides — not the AIO-only value.
      const currentHero = result.isMultiEngine
        ? (result.visibilityIndexPct ?? result.visibilityScore)
        : result.visibilityScore;
      // R2.1.1 — the trailing `?? 0` on the previous hero was the same
      // laundering as the history cards', one level up: a previous scan with no
      // score became "you were at 0", and the hero then reported a triumphant
      // climb that never happened. A trend needs a real number on both ends.
      //
      // ScoreBand renders nothing for a null trend, which is also what it does
      // when there IS no previous scan — so the reason is surfaced separately
      // (`trendUnavailable`, rendered under the band) rather than left as
      // silence that two different facts share.
      const hero = describeHeroTrend(currentHero, prev);
      scoreTrend = hero.trend;
      trendUnavailable = hero.unavailable;
    }
    if (prev) {
      previousScan = normalizeResult(prev, result.brand, result.website);
    }
    return { scoreTrend, trendUnavailable, previousScan, sortedHistory, deltaSamePromptSet };
  }, [result, history]);

  // ── error state ───────────────────────────────────────────────────
  //
  // R2.8.4 — kept ABOVE the empty state deliberately. A failed load must never
  // fall through to "Your dashboard is waiting": that tells a user with real
  // history that they have none, and invites them to spend a scan to fix a
  // problem that is ours. This state says what happened and offers a retry;
  // it does NOT offer to run a scan.
  if (error) {
    return (
      <div className="scan">
        <div className="scan__in">
          <div className="card" data-testid="dashboard-error" style={{ padding: "clamp(28px,4vw,48px)" }}>
            <span className="tag">Couldn't load</span>
            <h2 style={{ margin: "16px 0 14px", fontSize: "clamp(26px,3vw,38px)" }}>
              We couldn't reach your data
            </h2>
            <p className="scan__sub">
              {error} This is a problem on our side, not a missing report — your
              existing scans are unaffected.
            </p>
            <div style={{ marginTop: 28 }}>
              <button
                type="button"
                data-testid="error-retry"
                className="btn btn--primary btn--lg"
                onClick={() => window.location.reload()}
              >
                Try again
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── empty state ───────────────────────────────────────────────────
  if (result === null) {
    return (
      <div className="scan">
        <div className="scan__in">
          <div className="card" data-testid="dashboard-empty" style={{ padding: "clamp(28px,4vw,48px)" }}>
            <span className="tag tag--brand">No report yet</span>
            <h2 style={{ margin: "16px 0 14px", fontSize: "clamp(26px,3vw,38px)" }}>
              Your dashboard is waiting
            </h2>
            <p className="scan__sub">
              Run your first visibility check to see your share of AI, the answers behind it, and
              which rivals are taking the recommendations you wanted.
            </p>
            <div style={{ marginTop: 28 }}>
              <button
                type="button"
                data-testid="empty-run-scan"
                className="btn btn--primary btn--lg"
                onClick={() => router.push("/scan")}
              >
                Run a visibility check
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── loading state ─────────────────────────────────────────────────
  if (result === undefined) {
    return (
      <div className="app">
        <aside className="side">
          <div className="side__brand"><div className="skel" style={{ width: 110, height: 20 }} /></div>
          <div style={{ padding: "0 10px" }}>
            {Array.from({ length: 7 }, (_, i) => (
              <div key={i} className="skel" style={{ height: 30, marginBottom: 6 }} />
            ))}
          </div>
        </aside>
        <main className="main">
          <div className="topbar"><div className="skel" style={{ width: 160, height: 18 }} /></div>
          <div className="viewpad">
            <div className="grid g4" style={{ marginBottom: 13 }}>
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="skel" style={{ height: 96 }} />
              ))}
            </div>
            <div className="grid g-wide">
              <div className="skel" style={{ height: 280 }} />
              <div className="skel" style={{ height: 280 }} />
            </div>
          </div>
        </main>
      </div>
    );
  }

  /**
   * R2.2.6 (finding B3). This component does not decide what a degraded scan
   * is or how to word it — describeScanDataSourceIssue does, in the same module
   * that owns the thresholds the gate used, and it is unit-tested there. What
   * lives here is only the rendering.
   *
   * It is recomputed from the per-engine slices rather than read off
   * result.dataSourceIssue because the flag is one bit and the banner has to
   * name an engine and a number. Scans stored before this landed carry the
   * slices too, so the explanation is available for history, and `fallbackIssue`
   * covers the older single-engine records that have no slices at all.
   */
  const scanHealth = describeScanDataSourceIssue(result.perEngineSummaries, {
    enginesCounted: result.enginesCounted,
    fallbackIssue: result.dataSourceIssue,
  });
  const degradedEngineKeys = new Set(scanHealth.degradedEngines.map((e) => e.engine));

  /**
   * R3.2.5 (finding B3). The one thing on this screen that is READ, never
   * recomputed.
   *
   * `result.engineSetChange` is `summary_stats.engine_set_change`, written by
   * the worker when a checkpoint-frozen engine stopped resolving mid-scan
   * (`shrank`) or when the scan ended up answered by a different set than it
   * was frozen with (`refrozen`). Before it existed the headline was blended
   * over fewer engines, `engines_counted` fell, and this screen said nothing.
   *
   * IT CANNOT BE DERIVED HERE, which is why it is not, unlike `scanHealth`
   * above. The client does not know the set the scan was frozen onto or which
   * engines the registry resolves now; it cannot tell an engine that was
   * de-registered from one whose every probe errored; and it cannot see a
   * refreeze at all, because the substituted engines never appear in
   * `perEngineSummaries`. A missing key means the frozen set held — the worker
   * writes nothing on the happy path — so `null` here is "nothing changed",
   * not "we did not look".
   */
  const engineSetChange = result.engineSetChange || null;
  const engineSetRefrozen = engineSetChange?.state === "refrozen";
  const engineSetShrank = engineSetChange?.state === "shrank";
  /**
   * A record that arrived with a state this build does not know is still shown,
   * with the state printed verbatim. Rendering nothing because the vocabulary
   * grew would put us straight back in the silence this banner exists to end.
   */
  const engineSetUnknownState =
    !!engineSetChange && !engineSetRefrozen && !engineSetShrank;
  /**
   * The record names engines as `{ engine, label }`. A malformed one must still
   * produce a NAME — an unlabelled chip reading " — not probed" would be an
   * empty state dressed as an explanation.
   */
  const engineSetRefLabel = (e) =>
    (typeof e === "string" ? engineLabel(e) : e?.label || engineLabel(e?.engine)) ||
    "an engine this record did not name";
  const engineSetDropped = Array.isArray(engineSetChange?.dropped_engines)
    ? engineSetChange.dropped_engines
    : [];
  const engineSetSubstituted = Array.isArray(engineSetChange?.substituted_engines)
    ? engineSetChange.substituted_engines
    : [];

  /**
   * R2.7.8 (finding from R3.2.5) — the chip row on the headline.
   *
   * Two kinds of chip, and the difference is the whole point:
   *
   *   MEASURED — an engine with a slice. Carries its share as a number, and
   *     ScoreBand puts the percent sign on it.
   *   UNMEASURED — an engine the scan was frozen with that produced no slice.
   *     It appears in `engine_set_change.dropped_engines` and NOWHERE ELSE on
   *     this screen except R3.2.5's banner, so before this it was absent from
   *     the row: the reader saw the engines that answered and had no way to
   *     tell the set was smaller than the scan promised. It carries `value:
   *     null` and a state, and ScoreBand renders it as an em dash plus that
   *     state — never a 0, never a bare "—%".
   *
   * `value` is null rather than "—" on purpose: this component says WHETHER
   * there is a measurement, ScoreBand says what an absent one looks like.
   *
   * `state` / `state_reason` are read off the slice IF the pipeline put them
   * there (R2.1.1 is adding them) and simply absent otherwise. Nothing here
   * requires that shape to have landed.
   */
  const measuredEngineChips =
    result.perEngineSummaries &&
    typeof result.perEngineSummaries === "object" &&
    !Array.isArray(result.perEngineSummaries)
      ? Object.keys(result.perEngineSummaries).map((key) => {
          const summary = result.perEngineSummaries[key] || {};
          const share = summary.share_of_ai_pct;
          const measured = typeof share === "number" && Number.isFinite(share);
          const stateReason = summary.state_reason ?? null;
          let declaredState = summary.state ?? (measured ? null : "no share recorded");
          if (!measured && (declaredState === "did-not-report" || declaredState === "did_not_report" || stateReason === "no_results")) {
            declaredState = "did-not-report";
          } else if (!measured && (declaredState === "not_assessed" || declaredState === "not-assessed")) {
            declaredState = "not-assessed";
          }
          return {
            key: `engine-${key}`,
            // A degraded engine's share is a real measurement of an
            // incomplete read, so it is still shown — but never bare.
            // Unmarked, it looked exactly like the engines the index
            // was actually blended from.
            label: degradedEngineKeys.has(key)
              ? `${engineLabel(key)} (degraded)`
              : engineLabel(key),
            value: measured ? share : null,
            state: declaredState,
            stateReason,
          };
        })
      : [];

  const droppedEngineChips = engineSetDropped.map((e, i) => {
    const explicitState = typeof e === "object" && e?.state ? e.state : null;
    return {
      key: `dropped-${(typeof e === "string" ? e : e?.engine) ?? i}`,
      label: engineSetRefLabel(e),
      value: null,
      state: explicitState || "not probed",
      stateReason:
        engineSetChange?.title ||
        "This engine was frozen into the scan but produced no answer, so it is not in the index.",
    };
  });

  /**
   * The row is shown when the scan blended more than one engine, and ALSO
   * whenever an engine went missing — a two-engine scan that fell back to one
   * is exactly the case where `isMultiEngine` can stop being the interesting
   * question, and suppressing the row there would hide the omission this task
   * exists to end.
   */
  const engineChips =
    (result.isMultiEngine && measuredEngineChips.length > 0) || droppedEngineChips.length > 0
      ? [...measuredEngineChips, ...droppedEngineChips]
      : null;

  /* R2.1.3: engines_counted and UI vocabulary states.
     engines_counted is persisted and must be rendered on the dashboard so
     users know how many engines are blended into the AI Visibility Index.
     Read the raw stored value first: normalizeResult defaults enginesCounted to 0
     for legacy compatibility, so reading result.enginesCounted directly would
     falsely coerce an absent/null count to a measured zero. */
  const rawEnginesCounted =
    scan?.raw_results?.engines_counted !== undefined
      ? scan.raw_results.engines_counted
      : scan?.engines_counted !== undefined
        ? scan.engines_counted
        : result?.raw_results?.engines_counted !== undefined
          ? result.raw_results.engines_counted
          : result?.engines_counted !== undefined
            ? result.engines_counted
            : undefined;
  const enginesCountedRaw =
    rawEnginesCounted !== undefined ? rawEnginesCounted : result.enginesCounted;
  const enginesCounted =
    typeof enginesCountedRaw === "number" && Number.isFinite(enginesCountedRaw)
      ? enginesCountedRaw
      : null;
  const displayEnginesCounted =
    enginesCounted !== null
      ? `${enginesCounted} ${enginesCounted === 1 ? "engine" : "engines"} counted`
      : "— engines counted";

  const hasDidNotReport =
    (engineChips || []).some(
      (c) =>
        c.state === "did-not-report" ||
        c.state === "did_not_report" ||
        c.stateToken === "did-not-report" ||
        c.stateToken === "did_not_report"
    ) ||
    (result.perEngineSummaries &&
      typeof result.perEngineSummaries === "object" &&
      Object.values(result.perEngineSummaries).some(
        (s) =>
          s &&
          (s.state === "did-not-report" ||
            s.state === "did_not_report" ||
            s.state_reason === "no_results")
      ));

  /**
   * "There is no trustworthy slice left" — the state that suppresses the score
   * and replaces the views with the placeholder. It is deliberately NOT "any
   * engine degraded": a scan whose perplexity slice collapsed while aio answered
   * every prompt still has a real, if narrower, index, and blanking it would
   * hide a number we have in order to report one we do not. The partial banner
   * below is what says the index got narrower and why.
   */
  const dataSourceIssue = scanHealth.severity === "critical";

  // R2.4.2 — the shared gate-honoring selector, called on the raw scan row.
  // For multi-engine scans, visibility_pct IS the blended headline index
  // (enginePipeline writes it there since R2.4.1), so one call covers both
  // the score and the measurement state the hero needs.
  const heroMeasurement = scan ? describeScanMeasurement(scan) : null;

  const isNotAssessed =
    result.state === "not_assessed" ||
    result.state === "not-assessed" ||
    result.measurementState === "not_assessed" ||
    (heroMeasurement != null && !heroMeasurement.measured) ||
    (result.visibilityScore == null && !dataSourceIssue && result.visibilityIndexPct == null && result.shareOfAiPct == null);
  // Hero metric. Multi-engine: AI Visibility Index (equal-weight mean).
  // Single-engine: shareOfAiPct (the AIO-only value).
  const heroScore = result.isMultiEngine
    ? (result.visibilityIndexPct ?? result.shareOfAiPct ?? result.visibilityScore)
    : (result.shareOfAiPct ?? result.visibilityScore);
  /* R2.1.2, round 2 — NO SCORE, NO VERDICT.
     `heroScore` is genuinely nullable since R2.1.1 (a not_assessed scan stores
     no number), and the hero draws the em dash for it. The tier must be gated on
     the SAME condition the number is, or the band renders a red "Weak" chip
     beside that dash — a verdict derived from a measurement that does not exist.
     REDUNDANT WITH scoreTier, DELIBERATELY. The root cause is fixed in
     utils/format.js — scoreTier refuses a non-finite score and returns null — so
     on today's code this `Number.isFinite` test can never be the only thing
     stopping a chip. It stays because (a) this is also where `dataSourceIssue`
     suppresses a tier we *could* compute, so the two suppressions belong on one
     line, and (b) a reader of the surface that actually broke should not have to
     open format.js to know a null score cannot acquire a colour here. Both
     layers have their own test in heroVerdictNullScore.test.mjs; removing either
     one alone turns exactly one of them red. */
  const tier =
    dataSourceIssue || !Number.isFinite(heroScore) || (heroMeasurement != null && !heroMeasurement.measured)
      ? null
      : scoreTier(heroScore, result.scoringVersion);
  const brandAliases = getBrandAliases(result.brand, result.website);

  const handleHistoryClick = (scan) => {
    setResult(normalizeResult(scan, result.brand, result.website));
  };

  const handleRerun = async () => {
    if (isScanning) return;
    setIsScanning(true);
    setRerunStage(0);
    setRerunProgress(0);
    try {
      const { runScan, saveScan } = await import("@/services/api");
      const compStr =
        result.competitorsRaw !== undefined
          ? result.competitorsRaw
          : result.competitors
          ? result.competitors.map((c) => c.name).join(", ")
          : "";
      const newResult = await runScan(
        {
          brand: result.brand,
          website: result.website,
          industry: result.industry || "",
          competitors: compStr,
        },
        (s, p) => {
          setRerunStage(s);
          setRerunProgress(p !== undefined ? p : Math.round(((s + 1) / RERUN_STAGES.length) * 100));
        }
      );
      saveScan(newResult);
      setResult(newResult);
      setScanError(null);
      fetchScanHistory(result.brand).then((scans) => setHistory(scans || []));
    } catch (e) {
      console.error("Re-run failed:", e);
      setScanError(e.message || "Failed to run scan. Please try again.");
    } finally {
      setIsScanning(false);
    }
  };

  const mentionedNonBranded = (result.rawResults || []).filter(
    (r) =>
      !(r.is_branded_query ?? r.isBrandedQuery) &&
      !!(r.aio_present || r.aioPresent || r.answer_present) &&
      !!(r.brand_mentioned_in_text ?? r.brandMentionedInText)
  ).length;
  const citedNonBranded = (result.rawResults || []).filter(
    (r) =>
      !(r.is_branded_query ?? r.isBrandedQuery) &&
      !!(r.aio_present || r.aioPresent || r.answer_present) &&
      !!(r.brand_cited ?? r.brandCited)
  ).length;

  const hasBrandedData = (result?.brandPresencePromptsCount ?? 0) > 0;

  /* R2.1.2, round 2 — the no-tier arm. This map is keyed on `tier`, so gating the
     tier on a null score leaves it undefined, and OverviewView's "What the
     reading means" panel would render an EMPTY paragraph under its own heading:
     an empty state dressed as a clean one (standing rule 1). Before the gate it
     was worse — a null score fell through to "weak" and this panel stated
     "largely absent from Google AI Overviews for its category", a market verdict
     produced by a measurement that never happened. So say which of the two it
     is, in words, instead of leaving a blank for the reader to fill in.

     ONE sentence, not one per cause: `tier` is also null when `dataSourceIssue`
     is set, but that case never reaches here — the placeholder panel below
     replaces the whole view, so OverviewView (the only consumer of this value)
     is not rendered and a second arm for it would be a dead line. */
  const interpretation =
    tier == null
      ? "This scan produced no visibility score, so there is no verdict to interpret. The reading is not a zero — nothing was measured. Retry the scan, or add more high-intent queries."
      : {
          strong:
            "Your brand holds strong AI Overview presence. Defend the lead by monitoring high-intent comparison queries where rivals push hardest.",
          moderate:
            "You appear in some Google AI Overviews but miss most category queries. There is clear, addressable room to grow.",
          weak:
            "Your brand is largely absent from Google AI Overviews for its category. Competitors are winning the exact queries your buyers ask.",
        }[tier];

  const tierLabelMap = { strong: "Strong", moderate: "Moderate", weak: "Weak" };

  /* Whatever engines actually reported — not a hardcoded count of three. */
  const probeSources = result.isMultiEngine ? (result.probeSources || []) : ["aio"];

  /* R2.7.4 — the collection-window chip's ENTIRE rendering decision, resolved
     once so the guard and the label can never disagree. formatCollectionWindow
     returns null both for a half-known window (one end missing) and for one it
     cannot parse, so a window we cannot read is omitted exactly like a window
     we never had. Guarding on the raw strings instead — which is what shipped —
     let `collectedFrom: "garbage"` render a bare "collected" chip titled
     "Answers collected — → —": a malformed window claiming to be a measurement. */
  const collectionWindowLabel = formatCollectionWindow(result.collectedFrom, result.collectedTo);

  return (
    <div className="app">
      {/* Re-run overlay */}
      {isScanning && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: "fixed", inset: 0, zIndex: 50,
            display: "grid", placeItems: "center", padding: 24,
            background: "color-mix(in srgb, var(--paper) 88%, transparent)",
            backdropFilter: "blur(12px)",
          }}
        >
          <div className="card" style={{ padding: 30, maxWidth: 460, textAlign: "center" }}>
            <Loader2 size={26} style={{ color: "var(--brand)", margin: "0 auto 14px" }} aria-hidden="true" />
            <h4 style={{ marginBottom: 8 }}>
              {RERUN_STAGES[rerunStage] || "Probing the answer engines"}
            </h4>
            <p style={{ color: "var(--ink-3)", fontSize: 14, marginBottom: 18 }}>
              This keeps updating — it is not frozen. A slow run can take several minutes.
            </p>
            <div className="probe__bar">
              <i style={{ transform: `scaleX(${Math.max(0, Math.min(1, rerunProgress / 100))})` }} />
            </div>
            <div className="tag" style={{ marginTop: 10 }}>{rerunProgress}% complete</div>
          </div>
        </div>
      )}

      <Sidebar
        brand={result.brand}
        website={result.website}
        view={view}
        onViewChange={setView}
        history={sortedHistory}
        onHistoryClick={handleHistoryClick}
        activeScanTimestamp={result.scanTimestamp}
        onNewScan={() => router.push("/scan")}
        studioBadge={studioBadge}
        currentScore={heroScore ?? result.visibilityScore}
      />

      <main className="main">
        <div className="topbar">
          <h4>{VIEW_TITLE[view] || view}</h4>
          <span className="chip chip--you" data-testid="dashboard-brand">{result.brand}</span>
          <span className="tag">{result.website}</span>
          <span className="chip" title={`Scoring ${result.scoringVersion}`}>
            {probeSources.map(engineLabel).join(" · ")}
          </span>
          {/* R2.1.3: engines_counted rendered on the dashboard */}
          {(result.isMultiEngine || enginesCounted !== null || result.enginesCounted !== undefined || result.engines_counted !== undefined) && (
            <span
              className="chip"
              data-testid="dashboard-engines-counted"
              data-measured={enginesCounted !== null ? "true" : "false"}
              title="Number of engines blended into the headline AI Visibility Index"
            >
              {displayEnginesCounted}
            </span>
          )}
          {/* R2.1.3: UI chips for did-not-report / not-assessed / small-sample */}
          {hasDidNotReport && (
            <span
              className="chip chip--warn"
              data-testid="chip-did-not-report"
              title="One or more engines did not report answers"
            >
              Did not report
            </span>
          )}
          {isNotAssessed && (
            <span
              className="chip chip--warn"
              data-testid="chip-not-assessed"
              title="This reading was not assessed"
            >
              Not assessed
            </span>
          )}
          {result.insufficientSample && (
            <span
              className="chip chip--warn"
              data-testid="chip-small-sample"
              title="Only a small sample of prompts returned an answer"
            >
              Small sample
            </span>
          )}
          {/* A record with no collection time reads as an em dash and says so —
              it must not be indistinguishable from one collected a moment ago. */}
          {hasTimestamp(result.scanTimestamp) ? (
            <span
              data-testid="dashboard-timestamp"
              className="tag"
              style={{ marginLeft: "auto" }}
              /* R2.7.4 — the collection window, when we have one. A chunked or
                 crash-resumed scan collects over a real span, and reporting the
                 finalize instant as "when this was measured" compresses that
                 span to its far end. The headline stays the single timestamp
                 people scan for; the window is the honest detail behind it. */
              title={
                collectionWindowLabel
                  ? `Answers collected ${formatTimestamp(result.collectedFrom)} → ${formatTimestamp(result.collectedTo)}`
                  : undefined
              }
            >
              {formatTimestamp(result.scanTimestamp)} ({relativeTime(result.scanTimestamp)})
              {collectionWindowLabel && (
                <span
                  data-testid="collection-window"
                  className="chip"
                  style={{ marginLeft: 8 }}
                >
                  collected {collectionWindowLabel}
                </span>
              )}
            </span>
          ) : (
            <span data-testid="dashboard-timestamp" className="tag" style={{ marginLeft: "auto" }}>
              —{" "}
              <span className="chip chip--warn" title="This record carries no collection time, so its age is unknown.">
                No collection time
              </span>
            </span>
          )}
          <button
            type="button"
            data-print="hide"
            className="btn btn--ghost btn--sm"
            onClick={() => window.print()}
          >
            <Download size={14} aria-hidden="true" />
            Export
          </button>
          <button
            type="button"
            data-testid="rerun-scan-btn"
            data-print="hide"
            className="btn btn--ghost btn--sm"
            onClick={handleRerun}
            disabled={isScanning}
          >
            <RefreshCw size={14} aria-hidden="true" />
            {isScanning ? "Scanning…" : "Re-run"}
          </button>
        </div>

        <div className="viewpad" data-testid="dashboard">
          {/* ── banners ──────────────────────────────────────────── */}
          {scanError && (
            <div className="panel" style={{ marginBottom: 16, borderColor: "var(--crit)" }}>
              <div className="panel__h">
                <span className="chip chip--crit"><i className="chip__led" /> Error</span>
                <b>{scanError}</b>
                <button
                  type="button"
                  className="btn btn--quiet btn--sm"
                  style={{ marginLeft: "auto" }}
                  onClick={() => setScanError(null)}
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {result.isSample && (
            <div className="panel" data-testid="sample-banner" style={{ marginBottom: 16 }}>
              <div className="panel__h">
                <span className="chip chip--warn">
                  <FlaskConical size={11} aria-hidden="true" /> Sample
                </span>
                <b>Sample report — run a real scan to analyse your own brand.</b>
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  style={{ marginLeft: "auto" }}
                  onClick={() => router.push("/scan")}
                >
                  Run a scan
                </button>
              </div>
            </div>
          )}

          {dataSourceIssue && (
            <div
              className="panel"
              data-testid="data-source-issue-banner"
              style={{ marginBottom: 16, borderColor: "var(--crit)" }}
            >
              <div className="panel__h">
                <span className="chip chip--crit">
                  <ShieldAlert size={11} aria-hidden="true" /> Incomplete
                </span>
                <b>{scanHealth.title}</b>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  style={{ marginLeft: "auto" }}
                  onClick={handleRerun}
                  disabled={isScanning}
                >
                  <RefreshCw size={14} aria-hidden="true" />
                  Retry scan
                </button>
              </div>
              <div className="panel__b">
                <p style={{ fontSize: 14, color: "var(--ink-3)", marginBottom: 12 }}>
                  {scanHealth.detail}
                </p>
                {/* Per-engine numbers when the record carries slices; the aio-only
                    rows below are the fallback for records stored before it did.
                    Quoting the AIO thresholds at a Perplexity failure was part of
                    what made this banner uninformative. */}
                {scanHealth.degradedEngines.length > 0 ? (
                  <div className="rows">
                    {scanHealth.degradedEngines.map((engine) => (
                      <div className="row" key={engine.engine}>
                        <span className="row__n">
                          {engine.label} answer coverage
                          <span className="dim">(need ≥ {engine.min_coverage_pct}%)</span>
                        </span>
                        <span className="row__v">
                          {engine.coverage_pct == null || !Number.isFinite(engine.coverage_pct) ? "—" : `${engine.coverage_pct}%`}
                        </span>
                      </div>
                    ))}
                    {scanHealth.degradedEngines.map((engine) => (
                      <div className="row" key={`${engine.engine}-errors`}>
                        <span className="row__n">
                          {engine.label} error rate
                          <span className="dim">(limit {engine.error_rate_limit_pct}%)</span>
                        </span>
                        <span className="row__v">
                          {engine.error_rate_pct == null || !Number.isFinite(engine.error_rate_pct) ? "—" : `${engine.error_rate_pct}%`}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  /* R2.7.12 / R2.7.13 — em dash for unmeasured/nullish figures.
                     This is the banner whose entire job is to say the reading
                     is incomplete; printing "0%" for a coverage figure the
                     record does not carry claims a measurement on the one
                     screen that exists to deny one, and "0%" is also exactly
                     what a genuinely empty scan looks like. The degradedEngines
                     branch above writes the same em dash for unmeasured slices. */
                  <div className="rows">
                    <div className="row">
                      <span className="row__n">
                        Answer coverage
                        <span className="dim">
                          (need ≥ {Math.round(AIO_MIN_NON_BRANDED_COVERAGE * 100)}%)
                        </span>
                      </span>
                      <span className="row__v">
                        {result.aioCoveragePct == null ? "—" : `${result.aioCoveragePct}%`}
                      </span>
                    </div>
                    <div className="row">
                      <span className="row__n">
                        SERP error rate
                        <span className="dim">(limit {AIO_ERROR_RATE_LIMIT_PCT}%)</span>
                      </span>
                      <span className="row__v">
                        {result.aioErrorRatePct == null ? "—" : `${result.aioErrorRatePct}%`}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {scanHealth.severity === "partial" && (
            <div
              className="panel"
              data-testid="engine-degraded-banner"
              style={{ marginBottom: 16, borderColor: "var(--warn)" }}
            >
              <div className="panel__h">
                <span className="chip chip--warn">
                  <ShieldAlert size={11} aria-hidden="true" /> Partial read
                </span>
                <b>{scanHealth.title}</b>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  style={{ marginLeft: "auto" }}
                  onClick={handleRerun}
                  disabled={isScanning}
                >
                  <RefreshCw size={14} aria-hidden="true" />
                  Retry scan
                </button>
              </div>
              <div className="panel__b">
                <p style={{ fontSize: 14, color: "var(--ink-3)", marginBottom: 12 }}>
                  {scanHealth.detail}
                </p>
                <div className="rows">
                  {scanHealth.degradedEngines.map((engine) => (
                    <div className="row" key={engine.engine}>
                      <span className="row__n">
                        {engine.label} answer coverage
                        <span className="dim">(need ≥ {engine.min_coverage_pct}%)</span>
                      </span>
                      <span className="row__v">
                        {engine.coverage_pct == null || !Number.isFinite(engine.coverage_pct) ? "—" : `${engine.coverage_pct}%`}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/*
            R3.2.5 (finding B3) — why the engines counted fell.

            Rendered whenever the record carries the key, INDEPENDENT of
            `dataSourceIssue` and of `scanHealth.severity`: an engine that
            vanished from the registry is a different event from an engine that
            answered badly, both can happen to one scan, and suppressing this
            one behind the other would restore exactly the silence the finding
            is about. Every word below is read off the record — this component
            decides nothing about what changed or how to say it.
          */}
          {engineSetChange && (
            <div
              className="panel"
              data-testid="engine-set-change-banner"
              data-engine-set-state={engineSetChange.state ?? "unknown"}
              style={{
                marginBottom: 16,
                borderColor: engineSetRefrozen ? "var(--crit)" : "var(--warn)",
              }}
            >
              <div className="panel__h">
                <span className={engineSetRefrozen ? "chip chip--crit" : "chip chip--warn"}>
                  <ShieldAlert size={11} aria-hidden="true" />{" "}
                  {engineSetRefrozen
                    ? "Not comparable"
                    : engineSetShrank
                      ? "Fewer engines"
                      : `Engine set changed (${engineSetChange.state ?? "unrecognised"})`}
                </span>
                <b>
                  {engineSetChange.title ||
                    "The engine set this scan was frozen with changed while it ran, and the record did not say how."}
                </b>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  style={{ marginLeft: "auto" }}
                  onClick={handleRerun}
                  disabled={isScanning}
                >
                  <RefreshCw size={14} aria-hidden="true" />
                  Re-run scan
                </button>
              </div>
              <div className="panel__b">
                <p style={{ fontSize: 14, color: "var(--ink-3)", marginBottom: 12 }}>
                  {engineSetChange.detail ||
                    "This scan recorded an engine-set change but carried no explanation with it. Re-run the scan for a reading blended over the set it was frozen with."}
                </p>
                {engineSetUnknownState && (
                  <p style={{ fontSize: 13, color: "var(--ink-3)", marginBottom: 12 }}>
                    This build does not recognise the state “{String(engineSetChange.state ?? "—")}”,
                    so it is shown as the scan recorded it.
                  </p>
                )}
                {/* The engines themselves, named. A dropped engine has no slice
                    and no chip anywhere else on this screen, so this is the only
                    place a user can see which one stopped being probed. */}
                {engineSetDropped.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                    {engineSetDropped.map((e, i) => (
                      <span key={`dropped-${e?.engine ?? i}`} className="chip chip--crit">
                        {engineSetRefLabel(e)} — not probed
                      </span>
                    ))}
                  </div>
                )}
                {engineSetSubstituted.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                    {engineSetSubstituted.map((e, i) => (
                      <span key={`substituted-${e?.engine ?? i}`} className="chip chip--warn">
                        {engineSetRefLabel(e)} — answered instead, not in the frozen set
                      </span>
                    ))}
                  </div>
                )}
                <div className="rows">
                  <div className="row">
                    <span className="row__n">
                      Engines the index was blended over
                      <span className="dim">(frozen when the scan started)</span>
                    </span>
                    <span className="row__v">
                      {engineSetChange.engines_resolved == null ||
                      engineSetChange.engines_frozen == null
                        ? "—"
                        : `${engineSetChange.engines_resolved} of ${engineSetChange.engines_frozen}`}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {!dataSourceIssue && result.insufficientSample && (
            <div className="panel" data-testid="small-sample-warning" style={{ marginBottom: 16 }}>
              <div className="panel__h">
                <span className="chip chip--warn" data-testid="chip-small-sample">Small sample</span>
                <b>
                  Only {result.queriesWithAio ?? result.nonBrandedWithAio} of{" "}
                  {result.promptsTracked ?? result.promptsAnalyzed} tracked prompts returned a live
                  answer. Treat this score with caution.
                </b>
              </div>
            </div>
          )}

          {result.headlineQualified === false && (
            <div className="panel" data-testid="headline-qualification">
              <div className="panel__b">
                <b>Insufficient evidence for a headline</b>
                <p>{result.headlineReason === "insufficient_collection"
                  ? "Too much planned collection is missing."
                  : "The eligible sample does not meet the headline requirements."}</p>
                {Number.isFinite(result.exploratoryIndexPct) && <p>
                  Exploratory reading: {result.exploratoryIndexPct}%. This is not a qualified headline.
                </p>}
                {result.headlineMetric && <p>{result.headlineMetric.numerator ?? "—"} of {result.headlineMetric.denominator ?? "—"} eligible observations;
                  {" "}{result.headlineMetric.distinct_eligible_prompts ?? "—"} distinct prompts.</p>}
              </div>
            </div>
          )}

          {/* ── previous readings ────────────────────────────────── */}
          {sortedHistory && sortedHistory.length > 1 && (
            <div className="panel" style={{ marginBottom: 16 }}>
              <div className="panel__h">
                <b>Previous readings</b>
                <span className="tag">{sortedHistory.length} on record</span>
              </div>
              {/* wide content scrolls inside its own container */}
              <div className="panel__b panel__b--scroll">
                <div style={{ display: "flex", gap: 10 }}>
                  {sortedHistory.map((s, i) => {
                    const isActive = sameInstant(s.scanned_at, result.scanTimestamp);
                    const next = sortedHistory[i - 1];
                    const score = describeScanMeasurement(s);
                    const trend = describeHistoryDelta(next, s);
                    const cardDelta = trend.value;
                    const d = trend.delta;
                    return (
                      <button
                        key={i}
                        type="button"
                        className="stat"
                        onClick={() => handleHistoryClick(s)}
                        style={{
                          minWidth: 148, textAlign: "left", cursor: "pointer",
                          borderColor: isActive ? "var(--brand)" : undefined,
                          background: isActive ? "var(--brand-tint)" : undefined,
                        }}
                      >
                        <span className="stat__k">{formatTimestamp(s.scanned_at)}</span>
                        <span
                          className={`stat__v${isActive ? " is-you" : ""}`}
                          data-testid="history-card-score"
                          data-measured={score.measured ? "true" : "false"}
                          data-state-reason={score.reason || undefined}
                          title={score.detail || undefined}
                        >
                          {/* An unmeasured reading renders the dash WITHOUT the
                              unit — "—%" would still be claiming a percentage. */}
                          {score.measured ? (
                            <>{score.pct}<small>%</small></>
                          ) : (
                            score.text
                          )}
                        </span>
                        <span className="stat__d">
                          {d !== null && (
                            <span className={d > 0 ? "up" : d < 0 ? "dn" : "flat"}>
                              {d > 0 ? "+" : ""}{cardDelta}
                            </span>
                          )}
                          {/* Why there is no delta, when the reason is a missing
                              score rather than "this is the newest reading". */}
                          {trend.reason === "unmeasured_endpoint" && score.measured && (
                            <span
                              className="dim"
                              data-testid="history-card-delta-state"
                              title={trend.detail}
                            >
                              No change shown
                            </span>
                          )}
                          {/* `label` is set for BOTH absences and measured
                              zeroes — a 0 that was really measured must not read
                              as the same event as a missing one. */}
                          {score.label && (
                            <span
                              className="dim"
                              data-testid="history-card-state"
                              data-measured={score.measured ? "true" : "false"}
                              title={score.detail}
                            >
                              {score.label}
                            </span>
                          )}
                          <span className="dim">
                            {getHistoryNonBrandedCount(s)} tracked
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* ── the verdict ──────────────────────────────────────── */}
          {!dataSourceIssue && view === "overview" && (
            <div style={{ marginBottom: 16 }}>
              <ScoreBand
                score={heroScore}
                tier={tierLabelMap[tier]}
                trend={scoreTrend}
                promptSetChanged={!deltaSamePromptSet && !!previousScan}
                scoreLabel={result.isMultiEngine ? "AI Visibility Index" : null}
                engineChips={engineChips}
                enginesCounted={enginesCounted}
                stats={[
                  {
                    value:
                      result.visibleNonBranded == null ||
                      result.nonBrandedWithAio == null ||
                      result.nonBrandedWithAio === 0
                        ? "—"
                        : `${result.visibleNonBranded}/${result.nonBrandedWithAio}`,
                    label: "answers naming you",
                  },
                  {
                    value:
                      result.aioCoveragePct == null || !Number.isFinite(result.aioCoveragePct)
                        ? "—"
                        : `${result.aioCoveragePct}%`,
                    label: "answer coverage",
                  },
                  {
                    value:
                      result.promptsAnalyzed == null || !Number.isFinite(result.promptsAnalyzed)
                        ? "—"
                        : `${result.promptsAnalyzed}`,
                    label: "queries tracked",
                  },
                ]}
              />
              {/* A trend suppressed because a reading has no score is not the
                  same as a first scan with nothing to compare to, and ScoreBand
                  draws both as empty space. Say which one this is. */}
              {trendUnavailable && (
                <p
                  className="dim"
                  data-testid="trend-unavailable"
                  style={{ marginTop: 8, fontSize: 13 }}
                >
                  {trendUnavailable}
                </p>
              )}
              {/* R2.9.1 — provenance strip: engines, eliciting pool, dead
                  prompts, prompt-set version, geo, collection window.
                  All values are read off the persisted record; nothing
                  is recomputed here. */}
              <ProvenanceStrip result={result} />
            </div>
          )}

          {/* ── views ────────────────────────────────────────────── */}
          {dataSourceIssue && view !== "studio" ? (
            <div className="panel" data-testid="dashboard-unreliable-placeholder">
              <div className="blank">
                <ShieldAlert size={28} style={{ color: "var(--crit)" }} aria-hidden="true" />
                <h4>Not enough answer data</h4>
                <p>
                  The engines returned an answer for less than{" "}
                  {Math.round(AIO_MIN_NON_BRANDED_COVERAGE * 100)}% of your tracked queries. Rather
                  than pretending we have a real signal, we are showing nothing. Retry the scan, or
                  add more high-intent queries under Tracked queries.
                </p>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => setView("queries")}
                >
                  Open tracked queries
                </button>
              </div>
            </div>
          ) : (
            <>
              {view === "overview" && (
                <OverviewView
                  result={result}
                  dataSourceIssue={dataSourceIssue}
                  onTabChange={setView}
                  heroScore={heroScore}
                  aioCoverage={result.aioCoveragePct}
                  nonBrandedWithAio={result.nonBrandedWithAio ?? result.queriesWithAio}
                  promptsTracked={result.promptsTracked ?? result.promptsAnalyzed}
                  presenceRate={result.presenceRatePct}
                  visibleCount={result.visibleCount ?? result.visibleNonBranded}
                  competitorsFound={result.competitorsFound}
                  promptsAnalyzed={result.promptsAnalyzed}
                  mentionedNonBrandedCount={mentionedNonBranded}
                  citedNonBrandedCount={citedNonBranded}
                  interpretation={interpretation}
                  tier={tier}
                />
              )}

              {view === "answers" && (
                <div className="stack">
                  <AnswersView
                    data-testid="non-branded-evidence"
                    title="Non-branded queries"
                    subtitle={result.isMultiEngine
                      ? "Real searches your buyers make in this category. Open a row to read the actual answer from each engine."
                      : "Real Google searches your buyers make in this category. Open a row to read the actual AI Overview."}
                    prompts={result.nonBrandedResults || []}
                    brandAliases={brandAliases}
                    emptyLabel="No non-branded queries in this scan."
                    onGenerateContent={result.isSample ? undefined : handleGenerateContent}
                  />
                  {hasBrandedData && (
                    <AnswersView
                      data-testid="branded-evidence"
                      title={`Brand presence queries (${result.brandPresencePromptsCount || 0})`}
                      subtitle="Intentional own-name searches. Excluded from the headline score, because a branded question already contains its answer."
                      prompts={result.brandPresenceResults || []}
                      brandAliases={brandAliases}
                      emptyLabel="No brand presence queries were tracked in this scan."
                    />
                  )}
                </div>
              )}

              {view === "rivals" && (
                <RivalsView
                  competitors={result.competitors}
                  results={result.rawResults || []}
                  competitorsConfigured={result.competitorsConfigured}
                  rosterSource={result.rosterSource ?? null}
                />
              )}

              {view === "sources" && <SourcesView result={result} />}

              {view === "queries" && (
                <QueriesView
                  brand={resolveBrandKey(result.brand, result.website)}
                  legacyBrand={result.brand}
                  currentPrompts={result.topPrompts || []}
                />
              )}

              {view === "crawlability" && (
                <CrawlabilityView
                  brand={resolveBrandKey(result.brand, result.website)}
                  competitors={result.competitors}
                />
              )}

              {view === "studio" && (
                <div className="stack stack--tight">
                  {studioNotice && (
                    <div className="panel" style={{ borderColor: "var(--crit)" }}>
                      <div className="panel__h">
                        <span className="chip chip--crit">Error</span>
                        <b>{studioNotice}</b>
                        <button
                          type="button"
                          className="btn btn--quiet btn--sm"
                          style={{ marginLeft: "auto" }}
                          onClick={() => setStudioNotice(null)}
                        >
                          Dismiss
                        </button>
                      </div>
                    </div>
                  )}
                  <StudioView
                    brand={result.brand}
                    scan={result}
                    initialItemId={studioInitialItem}
                    onCountsChange={({ awaiting }) => setStudioBadge(awaiting)}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
