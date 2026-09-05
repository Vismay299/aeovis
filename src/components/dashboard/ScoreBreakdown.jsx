import React from "react";
import { motion } from "framer-motion";
import { ShieldCheck, MessageSquare, LineChart, Award } from "lucide-react";

import { formatPercent } from "@/components/perceev/charts/chartMath";
import {
  resolveShareOfVoice,
  describeShareMetric,
} from "@/components/perceev/charts/shareOfVoice";

/**
 * Score decomposition — the four headline numbers, and what each one does when
 * it was never measured.
 *
 * R2.7.6. Every metric on this panel used to read `result.<field> ?? 0` and
 * print `${value}%`, so an absent measurement arrived on screen as a confident
 * "0%" with a full-width empty progress track behind it. For share of voice
 * that was not an edge case but EVERY scan: nothing in the pipeline persists a
 * scan-level `shareOfVoicePct` (R2.7.5), so the field is always undefined and
 * the panel always claimed the brand held 0% of the mentions — a far stronger
 * and far worse claim than "we did not measure this". Standing rule 5: a null
 * metric is an em dash plus a state chip, never a zero.
 *
 * Share of voice is resolved by the same function the Overview donut uses
 * (resolveShareOfVoice) and worded by the same function
 * (describeShareMetric), so the two surfaces on one page cannot disagree about
 * one field again — which is exactly what this finding was.
 */

/** What an unmeasured non-share metric says. Never blank, never a bare dash. */
export const NOT_MEASURED_LABEL = "Not measured in this scan";

/**
 * How one plain percentage metric reads.
 *
 * Deliberately the same shape describeShareMetric returns, minus the share's
 * extra states, so the renderer below has exactly one branch for "measured" and
 * one for "not". The FORMAT is decided from the value here — formatPercent()
 * returns an em dash for anything non-finite — so no call site can staple a
 * percent sign onto a number that does not exist.
 *
 * @param {unknown} value
 * @returns {{measured: boolean, value: string, state: string|null, detail: string|null, progress: number|null}}
 */
export const describeMetricValue = (value) => {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : null;
  const measured = numeric !== null;
  return {
    measured,
    value: measured ? formatPercent(numeric) : "—",
    state: measured ? null : NOT_MEASURED_LABEL,
    detail: measured
      ? null
      : "This scan stored no value for this metric, so there is nothing to report — that is not the same as a zero.",
    progress: measured ? Math.max(0, Math.min(100, numeric)) : null,
  };
};

/** The bar behind a metric: a real fill when measured, hatching when not. */
const MetricTrack = ({ progress, color, measured }) => (
  <div
    className="w-full bg-[var(--panel-2)] h-1.5 rounded-full overflow-hidden mt-auto"
    data-testid="score-breakdown-track"
    data-track-measured={measured ? "true" : "false"}
  >
    {measured ? (
      <div className={`h-full ${color}`} style={{ width: `${progress}%` }} />
    ) : (
      /* Not a 0%-wide bar. An empty track and an unmeasured one looked
         identical before, which is how "we did not measure this" read as
         "you scored zero". */
      <div
        className="h-full w-full"
        style={{
          backgroundImage:
            "repeating-linear-gradient(135deg, var(--rule-1) 0 3px, transparent 3px 7px)",
        }}
      />
    )}
  </div>
);

export const ScoreBreakdown = ({ result }) => {
  if (!result) return null;

  const share = describeShareMetric(resolveShareOfVoice(result));

  const ci = {
    low: describeMetricValue(result.scoreCiLow),
    high: describeMetricValue(result.scoreCiHigh),
  };
  const ciMeasured = ci.low.measured && ci.high.measured;

  const metrics = [
    {
      key: "visibility_score",
      label: "AI Visibility Score",
      view: describeMetricValue(result.visibilityScore),
      icon: <Award className="w-5 h-5 text-[var(--lamp-amber)]" />,
      desc: "Headline composite score blending mention volume, ranking position, answer sentiment, and citation authority across B2B queries.",
      color: "bg-[var(--lamp-amber)]"
    },
    {
      key: "mention_rate",
      label: "Mention Rate",
      view: describeMetricValue(result.mentionRatePct),
      icon: <MessageSquare className="w-5 h-5 text-[var(--lamp-green)]" />,
      desc: "The percentage of B2B buyer queries where your brand is active and explicitly recommended by search AI engines.",
      color: "bg-[var(--lamp-green)]"
    },
    {
      key: "share_of_voice",
      label: "Share of Voice (SOV)",
      view: share,
      icon: <LineChart className="w-5 h-5 text-[var(--lamp-amber)]" />,
      desc: "Your share of recommendations compared directly to key competitors. Indicates B2B mindshare inside AI answer generation.",
      color: "bg-[var(--lamp-amber)]",
      shareState: share.rawState
    },
    {
      key: "citation_share",
      label: "Citation Share",
      view: describeMetricValue(result.brandCitationSharePct),
      icon: <ShieldCheck className="w-5 h-5 text-[var(--lamp-blue)]" />,
      desc: "The percentage of queries where your domain is cited in the reference links. Essential for organic referral traffic.",
      color: "bg-[var(--lamp-blue)]"
    }
  ];

  return (
    <div className="bg-[var(--panel-1)] border border-[var(--rule-1)] rounded-sm p-6 md:p-8">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-[var(--rule-1)] pb-5 mb-6">
        <div>
          <span className="text-xs uppercase tracking-[0.15em] text-[var(--text-2)] font-medium">
            Performance breakdown
          </span>
          <h3 className="font-serif text-2xl font-semibold text-[var(--text-1)] mt-1">
            Score Decomposition
          </h3>
        </div>
        <div className="flex flex-col items-end text-right">
          <span className="text-[10px] uppercase tracking-wider text-[var(--text-3)]">90% Bayesian Credible Interval</span>
          {/* An interval whose ends were never computed used to print
              "Likely Visibility Range: 0%–0%", which reads as a measured
              certainty of zero. */}
          <span
            className="text-base font-serif font-bold text-[var(--text-1)] mt-0.5"
            data-testid="score-breakdown-ci"
            data-ci-measured={ciMeasured ? "true" : "false"}
          >
            {ciMeasured
              ? `Likely Visibility Range: ${ci.low.value}–${ci.high.value}`
              : "Likely Visibility Range: —"}
          </span>
          {!ciMeasured && (
            <span
              className="text-[10px] text-[var(--text-3)] mt-0.5 border border-[var(--rule-1)] rounded-sm px-1.5 py-0.5"
              data-testid="score-breakdown-ci-state"
            >
              {NOT_MEASURED_LABEL}
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        {metrics.map((m, idx) => (
          <motion.div
            key={m.key}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: idx * 0.05 }}
            className="flex flex-col justify-between border border-[var(--rule-1)] rounded-sm p-5 hover:border-[var(--text-1)] transition-colors bg-[var(--panel-1)]"
            data-testid="score-breakdown-metric"
            data-metric={m.key}
            data-metric-measured={m.view.measured ? "true" : "false"}
            data-share-state={m.shareState || undefined}
          >
            <div>
              <div className="flex items-center justify-between mb-4">
                <span className="text-xs font-bold text-[var(--text-2)] uppercase tracking-wider">
                  {m.label}
                </span>
                {m.icon}
              </div>
              <span
                className="font-serif font-bold text-4xl text-[var(--text-1)] block mb-2"
                data-testid="score-breakdown-value"
              >
                {m.view.value}
              </span>
              {/* The chip is what makes a measured 0.0% and a never-computed
                  metric different objects on screen rather than the same one. */}
              {m.view.state && (
                <span
                  className="inline-block text-[10px] uppercase tracking-wider text-[var(--text-3)] border border-[var(--rule-1)] rounded-sm px-1.5 py-0.5 mb-2"
                  data-testid="score-breakdown-state"
                  title={m.view.detail || undefined}
                >
                  {m.view.state}
                </span>
              )}
              <p className="text-xs text-[var(--text-2)] leading-relaxed mb-6">
                {m.desc}
              </p>
              {!m.view.measured && m.view.detail && (
                <p
                  className="text-xs text-[var(--text-3)] leading-relaxed mb-6"
                  data-testid="score-breakdown-detail"
                >
                  {m.view.detail}
                </p>
              )}
            </div>
            <MetricTrack
              progress={m.view.progress}
              color={m.color}
              measured={m.view.measured}
            />
          </motion.div>
        ))}
      </div>
    </div>
  );
};
