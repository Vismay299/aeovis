import { RankTable, Donut } from "@/components/perceev/charts";
import { SectionStrap } from "./SectionStrap";

/**
 * Overview's "Visibility Rank" + "Share of Voice" row (P1.4) — the same
 * self + competitor `rankedEntries` list (built once in OverviewAnalytics so
 * the rank board, the donut, and the verdict sentence can never disagree)
 * rendered as a constituency rundown next to a share-of-voice ring, matching
 * the two-column layout proven in src/app/chart-preview/page.js.
 *
 * @param {object} result normalized scan record — only `.brand` is read here (display label)
 * @param {{name: string, value: number, isSelf?: boolean, delta?: number|null}[]} rankedEntries self + competitors, sorted descending by value
 */
export const RankAndSharePanel = ({ result, rankedEntries }) => {
  const brandLabel = result?.brand || "Your brand";

  return (
    <div
      data-testid="rank-share-row"
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(320px, 1.3fr) minmax(280px, 1fr)",
        gap: "var(--space-6)",
        alignItems: "start",
      }}
    >
      <div>
        <SectionStrap testId="rank-strap">Visibility Rank</SectionStrap>
        <RankTable rows={rankedEntries} />
      </div>
      <div>
        <SectionStrap testId="share-strap">Share of Voice</SectionStrap>
        <Donut segments={rankedEntries} centerLabel={`${brandLabel} share`} keyline="accent" />
      </div>
    </div>
  );
};
