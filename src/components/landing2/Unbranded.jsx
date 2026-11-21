"use client";

import { useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useGsap, gsap } from "./motion";
import { Tokens, tokenize } from "./markup";
import { BRAND, UNBRANDED_EXAMPLE } from "./sample";

/*
 * Two ways to ask. The branded one is written here to illustrate the shape of
 * a vanity query and is labelled as illustrative; the unbranded one is the
 * sample report's own question and its recorded answer, verbatim.
 */
const MODES = {
  branded: {
    tab: "Ask about yourself",
    q: `Is ${BRAND} a good platform for clinical analytics?`,
    a: `Yes. ${BRAND} is a well-regarded clinical analytics platform, known for its outcome dashboards and readmission tracking. Users highlight its reporting and its fit for mid-size hospitals.`,
    tag: "Illustrative",
    verdict: "Flattering, and useless. You named yourself, so of course the answer did too.",
    tone: "bad",
    youNamed: true,
  },
  unbranded: {
    tab: "Ask like a buyer",
    q: UNBRANDED_EXAMPLE.question,
    a: UNBRANDED_EXAMPLE.text,
    tag: "Sample report · verbatim",
    verdict: `${UNBRANDED_EXAMPLE.named.filter((n) => n !== BRAND).join(", ")} gets the recommendation. This is the answer your buyers actually read.`,
    tone: "good",
    youNamed: UNBRANDED_EXAMPLE.named.includes(BRAND),
  },
};

export default function Unbranded() {
  const root = useRef(null);
  const [mode, setMode] = useState("branded");
  const m = MODES[mode];

  useGsap(root, ({ reduced }) => {
    if (reduced) return;
    gsap.from(".lp2-unb__copy > *", {
      opacity: 0, y: 24, stagger: 0.08, duration: 1, ease: "power3.out",
      scrollTrigger: { trigger: root.current, start: "top 70%" },
    });
    gsap.from(".lp2-unb__panel", {
      opacity: 0, y: 60, rotateX: 8, duration: 1.4, ease: "expo.out",
      scrollTrigger: { trigger: ".lp2-unb__panel", start: "top 85%" },
    });
  });

  return (
    <section ref={root} className="lp2-unb lp2-section" aria-labelledby="lp2-unb-title">
      <div className="lp2-wrap lp2-unb__grid">
        <div className="lp2-unb__copy">
          <p className="lp2-eyebrow">Unbranded or it doesn&rsquo;t count</p>
          <h2 id="lp2-unb-title" className="lp2-h2">
            Ask AI about yourself<br />and it is polite.
            <span className="lp2-dim"> Ask like a buyer and it is honest.</span>
          </h2>
          <p className="lp2-lede">
            Most visibility tools put your brand in the prompt and report the flattering answer that comes back.
            Perceev never does. Every question is one a buyer would type before they know you exist, so the
            verdict reflects what they hear, not what you hoped for.
          </p>
        </div>

        <div className="lp2-unb__panel">
          <div className="lp2-seg" role="tablist" aria-label="Question style">
            {Object.entries(MODES).map(([key, val]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={mode === key}
                className="lp2-seg__btn"
                onClick={() => setMode(key)}
              >
                {mode === key ? (
                  <motion.span layoutId="lp2-seg-pill" className="lp2-seg__pill" transition={{ type: "spring", stiffness: 420, damping: 34 }} />
                ) : null}
                <span className="lp2-seg__label">{val.tab}</span>
              </button>
            ))}
          </div>

          <div className="lp2-unb__screen" role="tabpanel" aria-live="polite">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={mode}
                initial={{ opacity: 0, y: 14, filter: "blur(10px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                exit={{ opacity: 0, y: -10, filter: "blur(8px)" }}
                transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
              >
                <div className="lp2-unb__meta">
                  <span className="lp2-chip lp2-chip--ghost">{m.tag}</span>
                </div>
                <p className="lp2-unb__q">
                  <span className="lp2-console__label">Prompt</span>
                  {m.q}
                </p>
                <p className="lp2-unb__a">
                  <Tokens tokens={tokenize(m.a, { youNamed: m.youNamed })} className="is-lit" />
                </p>
                <p className={`lp2-unb__verdict lp2-unb__verdict--${m.tone}`}>{m.verdict}</p>
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>
    </section>
  );
}
