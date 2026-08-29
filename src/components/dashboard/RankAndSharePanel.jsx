import { RankTable, Donut } from "@/components/perceev/charts";
import { SectionStrap } from "./SectionStrap";

/**
 * Overview's "Visibility Rank" + "Share of Voice" row (P1.4) — the same
 * self + competitor `rankedEntries` list (built once in OverviewAnalytics so
 * the rank board, the donut, and the verdict sentence can never disagree)
 * rendered as a constituency rundown next to a share-of-voice ring, matching
 * the two-column layout first prototyped in the /chart-preview design harness
 * (deleted in R0.1.2 — it published a real customer brand's metrics on an
 * unauthenticated public route).
 *
 * @param {object} result normalized scan record — `.brand` (display label) and
 *   `.rosterSource` (R0.3.2: whether this scan's rival roster was measured at all)
 * @param {{name: string, value: number, isSelf?: boolean, delta?: number|null}[]} rankedEntries self + competitors, sorted descending by value
 */
export const RankAndSharePanel = ({ result, rankedEntries }) => {
  const brandLabel = result?.brand || "Your brand";

  return (
    /* g-wide collapses to one column at 1080px. Fixed minimums here (320px
       + 280px) could not fit a 375px viewport and pushed the page sideways. */
    <div data-testid="rank-share-row" className="grid g-wide">
      <div>
        <SectionStrap testId="rank-strap">Visibility Rank</SectionStrap>
        <RankTable rows={rankedEntries} />
      </div>
      <div>
        <SectionStrap testId="share-strap">Share of Voice</SectionStrap>
        <Donut
          segments={rankedEntries}
          centerLabel={`${brandLabel} share`}
          keyline="accent"
          rosterSource={result?.rosterSource ?? null}
        />
      </div>
    </div>
  );
};
