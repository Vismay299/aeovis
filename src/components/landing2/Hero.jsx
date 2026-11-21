"use client";

import { useRef } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { saveScan } from "@/shared/api";
import { SAMPLE_RESULT } from "@/shared/mockData";
import { useGsap, gsap, SplitText } from "./motion";
import ScanForm from "./ScanForm";
import AnswerConsole from "./AnswerConsole";
import { QUESTION_COUNT, ENGINE_SENTENCE_LIST } from "./sample";

/* WebGL only on the client, and only once the page has painted. */
const Threads = dynamic(() => import("@/components/reactbits/Threads"), { ssr: false });

export default function Hero() {
  const root = useRef(null);
  const router = useRouter();

  const openSample = () => {
    saveScan({ ...SAMPLE_RESULT, isSample: true });
    router.push("/dashboard");
  };

  useGsap(root, ({ reduced }) => {
    if (reduced) return;
    const split = SplitText.create(".lp2-hero__title", { type: "words,lines", mask: "lines", linesClass: "lp2-line" });
    const tl = gsap.timeline({ defaults: { ease: "expo.out" } });
    tl.from(".lp2-hero__eyebrow", { opacity: 0, y: 12, duration: 0.9 })
      .from(split.words, { yPercent: 110, opacity: 0, duration: 1.3, stagger: 0.06 }, "<0.1")
      .from(".lp2-hero__sub", { opacity: 0, y: 16, duration: 1.1 }, "-=0.9")
      .from(".lp2-hero__cta > *", { opacity: 0, y: 16, duration: 1, stagger: 0.08 }, "-=0.8")
      .from(".lp2-hero__threads", { opacity: 0, duration: 2.4, ease: "power2.out" }, 0);

    /* As the hero leaves, the copy lifts away. The WebGL layer stays put:
       moving a full-screen canvas on every scroll frame is pure GPU cost. */
    gsap.to(".lp2-hero__copy", {
      yPercent: -18,
      opacity: 0.2,
      ease: "none",
      scrollTrigger: { trigger: root.current, start: "top top", end: "bottom top", scrub: true },
    });
  });

  return (
    <section ref={root} className="lp2-hero" aria-labelledby="lp2-hero-title">
      <div className="lp2-hero__threads" aria-hidden="true">
        <Threads
          color={[0.96, 0.96, 0.97]}
          amplitude={1.2}
          distance={0.3}
          lineCount={40}
          maxRenderDim={1280}
          maxSegments={280}
          thickness={0.5}
          speed={0.35}
          brightness={0.9}
          opacity={0.55}
          angle={18}
          enableMouseInteraction
        />
      </div>
      <div className="lp2-hero__vignette" aria-hidden="true" />

      <div className="lp2-wrap lp2-hero__grid">
        <div className="lp2-hero__copy">
          <p className="lp2-hero__eyebrow lp2-eyebrow">
            <span className="lp2-pulse" aria-hidden="true" />
            Answer-engine intelligence
          </p>
          <h1 id="lp2-hero-title" className="lp2-hero__title">
            AI is answering your buyers.{" "}
            <span className="lp2-chrome">Is it saying your name?</span>
          </h1>
          <p className="lp2-hero__sub">
            Perceev puts {QUESTION_COUNT} unbranded buyer questions to {ENGINE_SENTENCE_LIST}, then shows
            you, answer by answer, who gets named: you, a rival, or nobody at all.
          </p>
          <div className="lp2-hero__cta">
            <ScanForm testId="lp2-hero-scan" />
            <p className="lp2-hero__fine">
              No signup.{" "}
              <button type="button" className="lp2-link" onClick={openSample} data-testid="preview-sample-cta">
                Or open the sample report
              </button>
            </p>
          </div>
        </div>
        <AnswerConsole />
      </div>

      <a href="#shift" className="lp2-hero__scroll" aria-label="Scroll to the next section">
        <span />
      </a>
    </section>
  );
}
