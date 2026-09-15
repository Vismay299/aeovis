import { RankTable, Donut } from "@/components/perceev/charts";
import { resolveShareOfVoice } from "@/components/perceev/charts/shareOfVoice";
import { SectionStrap } from "./SectionStrap";

/**
 * Overview's "Visibility Rank" + "Share of Voice" row (P1.4) — the self +
 * competitor `rankedEntries` list (built once in OverviewAnalytics so the rank
 * board and the verdict sentence can never disagree) rendered as a
 * constituency rundown, next to the scan's measured share of voice, matching
 * the two-column layout first prototyped in the /chart-preview design harness
 * (deleted in R0.1.2 — it published a real customer brand's metrics on an
 * unauthenticated public route).
 *
 * R2.7.1 (finding A8) — the two columns are no longer the same numbers twice.
 * `rankedEntries` is a VISIBILITY ranking and stays on the rank board; the
 * donut is fed the measured `share_of_voice_pct` instead, resolved by
 * resolveShareOfVoice(). Handing `rankedEntries` to the donut is what made it
 * divide visibility by its own sum and print "100.0% share" whenever the list
 * held one row — a number the scoring pipeline explicitly refuses to emit
 * (enginePipeline.js returns null for a slice with no rival roster). Nothing on
 * this side of the wire may reconstruct it.
 *
 * @param {object} result normalized scan record — `.brand` (display label),
 *   `.perEngineSummaries` (where `share_of_voice_pct` actually lives) and
 *   `.rosterSource` (R0.3.2: whether this scan's rival roster was measured at all)
 * @param {{name: string, value: number, isSelf?: boolean, delta?: number|null}[]} rankedEntries self + competitors, sorted descending by value
 */
export const RankAndSharePanel = ({ result, rankedEntries }) => {
  const brandLabel = result?.brand || "Your brand";
  const share = resolveShareOfVoice(result);

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
          share={share}
          centerLabel={`${brandLabel} share`}
          keyline="accent"
          rosterSource={result?.rosterSource ?? null}
        />
      </div>
    </div>
  );
};
