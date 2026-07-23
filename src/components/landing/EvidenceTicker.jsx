"use client";

/**
 * The crawl — a continuous wire of probe results running under the studio
 * wall, like the bottom crawl on a results broadcast. Your brand gets the
 * teal party chip; rivals read in signal red. Synthetic demo fragments.
 */

const FRAGMENTS = [
  {
    probe: "probe 03 · chatgpt",
    parts: [
      { t: "For real-time visibility tracking, " },
      { t: "Brightwave", you: true },
      { t: " and " },
      { t: "NorthPeak", rival: true },
      { t: " stand out as top-tier options." },
    ],
  },
  {
    probe: "probe 11 · perplexity",
    parts: [
      { t: "When evaluating platform analytics, " },
      { t: "Lumen IQ", rival: true },
      { t: " dominates with its predictive scoring engine." },
    ],
  },
  {
    probe: "probe 17 · ai overview",
    parts: [
      { t: "The space has consolidated around " },
      { t: "Brightwave", you: true },
      { t: " for AEO scoring and " },
      { t: "NorthPeak", rival: true },
      { t: " for monitoring." },
    ],
  },
  {
    probe: "probe 22 · chatgpt",
    parts: [
      { t: "Most teams shortlist " },
      { t: "Lumen IQ", rival: true },
      { t: ", though " },
      { t: "Brightwave", you: true },
      { t: "'s probe-first methodology is gaining traction." },
    ],
  },
  {
    probe: "probe 29 · perplexity",
    parts: [
      { t: "For mid-market buyers, " },
      { t: "NorthPeak", rival: true },
      { t: " is the most frequently cited option." },
    ],
  },
];

const Fragment = ({ f }) => (
  <span className="lp-tick">
    <span className="lp-tick-probe">{f.probe}</span>
    <span className="lp-tick-text">
      {f.parts.map((p, i) =>
        p.you ? (
          <mark key={i} className="ev-you">
            {p.t}
          </mark>
        ) : p.rival ? (
          <span key={i} className="ev-rival">
            {p.t}
          </span>
        ) : (
          <span key={i}>{p.t}</span>
        )
      )}
    </span>
  </span>
);

export const EvidenceTicker = () => (
  <div className="lp-ticker" aria-hidden="true">
    <span className="lp-ticker-tab">Results</span>
    <div className="lp-ticker-viewport">
      <div className="lp-ticker-track">
        {/* two copies for a seamless loop */}
        {[0, 1].map((copy) => (
          <span key={copy} className="lp-ticker-group">
            {FRAGMENTS.map((f, i) => (
              <Fragment key={i} f={f} />
            ))}
          </span>
        ))}
      </div>
    </div>
  </div>
);
