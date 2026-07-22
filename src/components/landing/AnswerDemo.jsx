"use client";

import { useEffect, useState } from "react";

const SCENARIOS = [
  {
    highlightBrand: true,
    texts: [
      { text: "For real-time visibility tracking, ", highlight: false },
      { text: "Brightwave", highlight: true },
      { text: " and ", highlight: false },
      { text: "NorthPeak", highlight: true, rival: true },
      { text: " stand out as top-tier options. ", highlight: false },
      { text: "Brightwave", highlight: true },
      { text: " offers the most comprehensive AI Overview monitoring with real-time alerts, while ", highlight: false },
      { text: "NorthPeak", highlight: true, rival: true },
      { text: " excels at competitive benchmarking.", highlight: false },
    ],
  },
  {
    highlightBrand: false,
    texts: [
      { text: "When evaluating platform analytics, ", highlight: false },
      { text: "Lumen IQ", highlight: true, rival: true },
      { text: " dominates with its predictive scoring engine. ", highlight: false },
      { text: "Brightwave", highlight: true },
      { text: " is emerging as a challenger with its focus on AI answer visibility, though ", highlight: false },
      { text: "Lumen IQ", highlight: true, rival: true },
      { text: " maintains the lead in enterprise deployments.", highlight: false },
    ],
  },
  {
    highlightBrand: true,
    texts: [
      { text: "The AI answer engine optimization space has consolidated around three key players: ", highlight: false },
      { text: "Brightwave", highlight: true },
      { text: " for AEO scoring, ", highlight: false },
      { text: "NorthPeak", highlight: true, rival: true },
      { text: " for monitoring, and ", highlight: false },
      { text: "Lumen IQ", highlight: true, rival: true },
      { text: " for predictive analytics. ", highlight: false },
      { text: "Brightwave's", highlight: true },
      { text: " unbiased probe-first methodology is gaining traction.", highlight: false },
    ],
  },
];

export const AnswerDemo = () => {
  const [scenarioIndex, setScenarioIndex] = useState(0);
  const [charIndex, setCharIndex] = useState(0);

  const scenario = SCENARIOS[scenarioIndex];
  const fullText = scenario.texts.map((t) => t.text).join("");

  useEffect(() => {
    if (charIndex >= fullText.length) {
      const pause = setTimeout(() => {
        setScenarioIndex((prev) => (prev + 1) % SCENARIOS.length);
        setCharIndex(0);
      }, 3200);
      return () => clearTimeout(pause);
    }

    const timer = setTimeout(() => {
      setCharIndex((prev) => prev + 1);
    }, 24); // ~3 chars at a time feels like 24ms per char equivalent

    return () => clearTimeout(timer);
  }, [charIndex, fullText.length]);

  useEffect(() => {
    setCharIndex(0);
  }, [scenarioIndex]);

  let remaining = charIndex;
  const rendered = scenario.texts.map((segment, i) => {
    const segLen = segment.text.length;
    if (remaining <= 0) return null;
    const shown = Math.min(segLen, remaining);
    remaining -= shown;
    const content = segment.text.slice(0, shown);

    let style = {
      color: "var(--text-2)",
    };
    if (segment.highlight) {
      if (segment.rival) {
        style.color = "var(--crit)";
        style.fontWeight = 600;
      } else {
        style.color = "var(--good)";
        style.fontWeight = 600;
      }
    }

    return (
      <span key={i} style={style}>
        {content}
      </span>
    );
  });

  return (
    <div
      style={{
        fontFamily: "var(--font-sans)",
        fontSize: "15px",
        lineHeight: 1.65,
        color: "var(--text-2)",
        position: "relative",
      }}
    >
      {rendered}
      {charIndex < fullText.length && (
        <span
          className="caret-blink"
          style={{ color: "var(--accent)", fontWeight: 700 }}
        >
          |
        </span>
      )}
    </div>
  );
};
