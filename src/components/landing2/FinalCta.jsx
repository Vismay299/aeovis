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
    const split = SplitText.create(".lp2-final__title", { type: "chars,words", charsClass: "lp2-char" });
    gsap.from(split.chars, {
      opacity: 0,
      yPercent: 60,
      rotateX: -70,
      stagger: 0.018,
      duration: 1.1,
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
