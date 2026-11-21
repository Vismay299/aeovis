"use client";

import { useRef } from "react";
import dynamic from "next/dynamic";
import { useGsap, gsap, SplitText } from "./motion";
import ScanForm from "./ScanForm";
import { QUESTION_COUNT, WINS, BRAND } from "./sample";

const Orb = dynamic(() => import("./Orb"), { ssr: false });

export default function FinalCta() {
  const root = useRef(null);

  useGsap(root, ({ reduced }) => {
    if (reduced) return;
    /* Words rise out of masked lines, in 2D only. A per-letter 3D tilt was
       tried first: Chrome mis-composites background-clip:text on 3D-transformed
       layers and painted the letters white and stacked at the line start. */
    const split = SplitText.create(".lp2-final__title", { type: "words,lines", mask: "lines", linesClass: "lp2-line" });
    gsap.from(split.words, {
      yPercent: 110,
      opacity: 0,
      stagger: 0.06,
      duration: 1.2,
      ease: "expo.out",
      scrollTrigger: { trigger: root.current, start: "top 65%" },
    });
    gsap.from(".lp2-final__orb", {
      scale: 0.7, opacity: 0, duration: 2, ease: "expo.out",
      scrollTrigger: { trigger: root.current, start: "top 75%" },
    });
    gsap.from(".lp2-final__cta > *", {
      opacity: 0, y: 20, stagger: 0.1, duration: 1, ease: "power3.out",
      scrollTrigger: { trigger: ".lp2-final__cta", start: "top 90%" },
    });
  });

  return (
    <section ref={root} className="lp2-final" aria-labelledby="lp2-final-title">
      <div className="lp2-final__orb"><Orb /></div>
      <div className="lp2-wrap lp2-final__inner">
        <p className="lp2-eyebrow">Your turn</p>
        <h2 id="lp2-final-title" className="lp2-final__title">
          Find out what AI tells your buyers.
        </h2>
        <p className="lp2-lede lp2-final__lede">
          Behind this line, the brighter points are the sample&rsquo;s {QUESTION_COUNT} questions; the {WINS} brightest are
          answers that named {BRAND}. Run the same scan on your own domain, free, with no signup.
        </p>
        <div className="lp2-final__cta">
          <ScanForm testId="lp2-final-scan" />
        </div>
      </div>
    </section>
  );
}
