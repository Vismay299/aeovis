"use client";

import { useRef, useState } from "react";
import { useGsap, gsap } from "./motion";
import { Tokens, tokenize } from "./markup";
import { ENGINE_LABELS } from "@/shared/engines/deployedEngines";
import { EVIDENCE, BRAND } from "./sample";

const VERDICT = {
  you: () => `${BRAND} named`,
  r1: (item) => `${item.named.filter((n) => n !== BRAND)[0]} named · ${BRAND} absent`,
  r2: (item) => `${item.named.filter((n) => n !== BRAND)[0]} named · ${BRAND} absent`,
  none: () => "No brand named",
};

/**
 * A scripted replay of three answers from the sample report. It is labelled as
 * a sample and carries no timestamp: it shows the shape of a reading, not a
 * live one. The engine chip names an engine this deployment actually probes.
 */
export default function AnswerConsole({ ready }) {
  const root = useRef(null);
  const [replayIndex, setReplayIndex] = useState(null);
  const initial = replayIndex === null;
  const index = initial ? 0 : replayIndex;
  const item = EVIDENCE[index];
  const tokens = tokenize(item.text, { youNamed: item.named.includes(BRAND) });
  const engineLabel = ENGINE_LABELS[item.engine];

  useGsap(root, ({ reduced }) => {
    if (!ready) return;
    const words = gsap.utils.toArray(".lp2-console__answer .lp2-w");
    const marks = gsap.utils.toArray(".lp2-console__answer .lp2-mark");
    const next = (index + 1) % EVIDENCE.length;
    const advance = () => setReplayIndex(next);

    // Reveal a complete example with the page before the replay starts.
    if (initial || reduced) {
      marks.forEach((m) => m.classList.add("is-lit"));
      if (!reduced) {
        gsap.timeline()
          .to(".lp2-console__body", { opacity: 0, y: -8, duration: 0.5, ease: "power2.in" }, "+=3.4")
          .add(advance);
      }
      return;
    }

    gsap.timeline()
      .fromTo(".lp2-console__body", { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.4, ease: "power2.out" })
      .fromTo(
        ".lp2-console__q",
        { clipPath: "inset(0 100% 0 0)" },
        { clipPath: "inset(0 0% 0 0)", duration: Math.min(2.2, item.question.length * 0.045), ease: `steps(${item.question.length})` },
        "<",
      )
      .fromTo(".lp2-console__caret", { opacity: 1 }, { opacity: 0, duration: 0.2 })
      .fromTo(".lp2-console__thinking", { opacity: 0, scaleX: 0.2 }, { opacity: 1, scaleX: 1, duration: 0.4, ease: "power2.out" })
      .to(".lp2-console__thinking", { opacity: 0, duration: 0.3 }, "+=0.5")
      .fromTo(
        words,
        { opacity: 0, y: 4 },
        { opacity: 1, y: 0, duration: 0.35, stagger: 0.028, ease: "power2.out" },
        "<",
      )
      .add(() => marks.forEach((m) => m.classList.add("is-lit")), "-=0.4")
      .fromTo(".lp2-console__verdict", { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.5, ease: "power3.out" })
      .to(".lp2-console__body", { opacity: 0, y: -8, duration: 0.5, ease: "power2.in" }, "+=3.4")
      .add(advance);
  }, [ready, replayIndex]);

  return (
    <div ref={root} className="lp2-console-wrap">
      <div className="lp2-console" role="figure" aria-label={`Sample answer for the question: ${item.question}`}>
        <div className="lp2-console__chrome">
          <span className="lp2-dots" aria-hidden="true"><i /><i /><i /></span>
          <span className="lp2-chip">{engineLabel}</span>
          <span className="lp2-chip lp2-chip--ghost">Sample · fictional brands</span>
        </div>
        <div className="lp2-console__body" key={index}>
          <p className="lp2-console__ask">
            <span className="lp2-console__label">Buyer asks</span>
            <span className="lp2-console__q">{item.question}</span>
            {!initial && <span className="lp2-console__caret" aria-hidden="true" />}
          </p>
          <div className="lp2-console__thinking" aria-hidden="true" />
          <p className="lp2-console__answer">
            <Tokens tokens={tokens} />
          </p>
          <div className="lp2-console__verdict" data-won={item.won}>
            <span className="lp2-console__verdict-dot" aria-hidden="true" />
            {VERDICT[item.won](item)}
          </div>
        </div>
        <ol className="lp2-console__pager" aria-hidden="true">
          {EVIDENCE.map((e, i) => (
            <li key={e.question} data-on={i === index ? "true" : "false"} />
          ))}
        </ol>
      </div>
    </div>
  );
}
