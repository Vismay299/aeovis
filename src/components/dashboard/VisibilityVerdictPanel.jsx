import { formatPercent, isFiniteNumber } from "@/components/perceev/charts/chartMath";
import { SectionStrap } from "./SectionStrap";
import { describeRosterState } from "@/lib/scoring/rosterContinuity";

// Only 2 engines are configured today (aio, perplexity), but this map is
// deliberately not the source of truth for which engines exist — it only
// prettifies whatever keys actually show up in result.perEngineSummaries.
const ENGINE_LABELS = {
  aio: "Google AI Overviews",
  chatgpt: "ChatGPT",
  perplexity: "Perplexity",
};

const engineLabel = (key) => ENGINE_LABELS[key] || String(key).toUpperCase();

/** Bolded self-figure — the one spot of `--you` teal allowed in prose (DESIGN.md: teal marks you wherever you appear in data). */
const You = ({ children }) => <strong style={{ color: "var(--you)", fontWeight: 700 }}>{children}</strong>;
/** Bolded rival/leader figure — emphasis only, no role color (gold/red are reserved for declarations and the rival chart role, not sentence decoration). */
const Emph = ({ children }) => <strong style={{ fontWeight: 700 }}>{children}</strong>;

/**
 * Overview's "The Verdict" block (P1.4) — a deterministic, metric-driven
 * headline sentence in the Results Night voice (DESIGN.md: "Verdict-first:
 * headline, then evidence"). No LLM call: every clause is read straight off
 * `rankedEntries` (the SAME sorted self+competitor list the rank board and
 * donut render, so the claimed rank can never disagree with the chart below
 * it) and `result.perEngineSummaries`. When a claim isn't supported by real
 * data (no rivals yet, no per-engine breakdown), that clause is omitted
 * rather than invented.
 *
 * @param {object} result normalized scan record (brand, perEngineSummaries)
 * @param {{name: string, value: number, isSelf?: boolean}[]} rankedEntries self + competitors, sorted descending by value
 */
export const VisibilityVerdictPanel = ({ result, rankedEntries }) => {
  const brandLabel = result?.brand || "Your brand";
  const entries = Array.isArray(rankedEntries) ? rankedEntries : [];
  const selfIndex = entries.findIndex((e) => e.isSelf);
  const selfEntry = selfIndex >= 0 ? entries[selfIndex] : { name: brandLabel, value: 0 };
  const hasRivals = entries.length > 1;
  const leader = entries[0];
  const runnerUp = entries[1];
  // R0.3.2: the headline's rival clauses below are positive claims about what
  // the answers contained. They are only true when rival extraction actually
  // ran; otherwise the sentence must say the scan could not look at all.
  const rosterState = describeRosterState(result?.rosterSource ?? null);

  // Zero is a real measurement, but "visible at 0.0%" / "leads at 0.0%" reads
  // self-contradictory in prose (unlike a bar or wedge, where 0 just renders
  // empty) — branch on it explicitly rather than let the generic phrasing
  // claim a "lead" or "visibility" that isn't there.
  let headline;
  if (!rosterState.assessable) {
    headline = (
      <>
        <Emph>{rosterState.label}.</Emph> {rosterState.detail}
      </>
    );
  } else if (!hasRivals) {
    headline =
      selfEntry.value > 0 ? (
        <>
          <Emph>{brandLabel}</Emph> is tracked and visible at <You>{formatPercent(selfEntry.value)}</You> — no rival
          brands have been co-mentioned in AI Overviews yet.
        </>
      ) : (
        <>
          <Emph>{brandLabel}</Emph> hasn&apos;t appeared in an AI Overview yet, and no rival brands have been
          co-mentioned either.
        </>
      );
  } else if (leader.value === 0) {
    // Sorted descending, so a zero leader means every entry — self included — is zero.
    headline = (
      <>
        No brand in this set — including <Emph>{brandLabel}</Emph> — has measured AI visibility yet.
      </>
    );
  } else if (selfIndex === 0) {
    headline = (
      <>
        You lead AI visibility at <You>{formatPercent(selfEntry.value)}</You> — <Emph>{runnerUp.name}</Emph> is
        closest at <Emph>{formatPercent(runnerUp.value)}</Emph>.
      </>
    );
  } else {
    headline = (
      <>
        You&apos;re <You>#{selfIndex + 1}</You> in AI visibility at <You>{formatPercent(selfEntry.value)}</You> —{" "}
        <Emph>{leader.name}</Emph> leads at <Emph>{formatPercent(leader.value)}</Emph>.
      </>
    );
  }

  // Strongest/weakest engine — only when at least one engine has a real
  // (non-null) share_of_ai_pct. sov_pct/sentiment_avg/position_avg are NOT
  // used here on purpose: they're unmeasured (NULL) until symmetric judging
  // ships, so this line only ever speaks to visibility share, which is real.
  const engineSummaries = result?.perEngineSummaries || null;
  const engineEntries = engineSummaries
    ? Object.entries(engineSummaries)
        .map(([key, s]) => ({ key, value: s?.share_of_ai_pct }))
        .filter((e) => isFiniteNumber(e.value))
    : [];

  let engineLine = null;
  if (engineEntries.length >= 2) {
    const sorted = [...engineEntries].sort((a, b) => b.value - a.value);
    const strongest = sorted[0];
    const weakest = sorted[sorted.length - 1];
    engineLine = `Strongest on ${engineLabel(strongest.key)} (${formatPercent(strongest.value)}), weakest on ${engineLabel(
      weakest.key
    )} (${formatPercent(weakest.value)}).`;
  } else if (engineEntries.length === 1) {
    engineLine = `Measured via ${engineLabel(engineEntries[0].key)} only, at ${formatPercent(engineEntries[0].value)}.`;
  }

  return (
    <div
      data-testid="overview-verdict"
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
      <SectionStrap testId="verdict-strap">The Verdict</SectionStrap>
      <p
        data-testid="verdict-headline"
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: "22px",
          fontWeight: 600,
          lineHeight: 1.35,
          letterSpacing: "-0.01em",
          color: "var(--text-1)",
        }}
      >
        {headline}
      </p>
      {engineLine && (
        <p
          data-testid="verdict-engine-line"
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: "14px",
            color: "var(--text-2)",
            lineHeight: 1.5,
            marginTop: "var(--space-3)",
          }}
        >
          {engineLine}
        </p>
      )}
    </div>
  );
};
