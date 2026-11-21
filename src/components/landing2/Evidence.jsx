"use client";

import { useRef, useState } from "react";
import { motion } from "motion/react";
import { Quote, Link2, Users, Cpu } from "lucide-react";
import { ENGINE_LABELS } from "@/shared/engines/deployedEngines";
import { GlowingEffect } from "@/components/aceternity/glowing-effect";
import { useGsap, gsap } from "./motion";
import { Tokens, tokenize } from "./markup";
import { EVIDENCE, BRAND, RIVAL_NAMES } from "./sample";

const TAB_LABEL = { you: "An answer you won", r1: "An answer a rival won", r2: "An answer a rival won", none: "An answer nobody won" };

export default function Evidence() {
  const root = useRef(null);
  const [index, setIndex] = useState(0);
  const item = EVIDENCE[index];
  /* Rivals as the reader sees them: every rival the answer text names. */
  const rivals = RIVAL_NAMES.filter((n) => item.text.includes(n));
  const youNamed = item.named.includes(BRAND);

  useGsap(root, ({ reduced }) => {
    if (reduced) return;
    gsap.from(".lp2-ev__head > *", {
      opacity: 0, y: 24, stagger: 0.08, duration: 1, ease: "power3.out",
      scrollTrigger: { trigger: root.current, start: "top 70%" },
    });
  }, []);

  /* Each tab change re-reads the answer: words settle in, then the marks draw. */
  useGsap(root, ({ reduced }) => {
    const words = gsap.utils.toArray(".lp2-ev__text .lp2-w");
    const marks = gsap.utils.toArray(".lp2-ev__text .lp2-mark");
    const notes = gsap.utils.toArray(".lp2-ev__note");
    if (reduced) {
      marks.forEach((m) => m.classList.add("is-lit"));
      return;
    }
    const tl = gsap.timeline({ scrollTrigger: { trigger: ".lp2-ev__card", start: "top 75%" } });
    tl.fromTo(words, { opacity: 0.1 }, { opacity: 1, duration: 0.3, stagger: 0.012, ease: "none" })
      .add(() => marks.forEach((m) => m.classList.add("is-lit")), "-=0.3")
      .fromTo(notes, { opacity: 0, x: 16 }, { opacity: 1, x: 0, stagger: 0.09, duration: 0.6, ease: "power3.out" }, "-=0.4");
  }, [index]);

  return (
    <section ref={root} id="evidence" className="lp2-ev lp2-section" aria-labelledby="lp2-ev-title">
      <div className="lp2-wrap">
        <div className="lp2-ev__head">
          <p className="lp2-eyebrow">Evidence, verbatim</p>
          <h2 id="lp2-ev-title" className="lp2-h2">
            Every verdict comes with the receipt.
          </h2>
          <p className="lp2-lede">
            No abstract scores you have to take on trust. Open any answer and read exactly what the engine said,
            who it named, and which pages it leaned on to say it.
          </p>
        </div>

        <div className="lp2-ev__tabs" role="tablist" aria-label="Sample answers">
          {EVIDENCE.map((e, i) => (
            <button
              key={e.question}
              type="button"
              role="tab"
              aria-selected={i === index}
              className="lp2-ev__tab"
              onClick={() => setIndex(i)}
            >
              {i === index ? (
                <motion.span layoutId="lp2-ev-pill" className="lp2-ev__pill" transition={{ type: "spring", stiffness: 380, damping: 32 }} />
              ) : null}
              <span className="lp2-ev__tablabel">{TAB_LABEL[e.won]}</span>
            </button>
          ))}
        </div>

        <div className="lp2-ev__grid">
          <article className="lp2-card lp2-ev__card" key={index} role="tabpanel">
            <GlowingEffect spread={48} glow disabled={false} proximity={80} inactiveZone={0.01} borderWidth={1} variant="white" />
            <header className="lp2-ev__cardhead">
              <span className="lp2-chip">{ENGINE_LABELS[item.engine]}</span>
              <span className="lp2-chip lp2-chip--ghost">Sample report · verbatim</span>
            </header>
            <p className="lp2-ev__q"><Quote size={14} aria-hidden="true" /> {item.question}</p>
            <p className="lp2-ev__text"><Tokens tokens={tokenize(item.text, { youNamed })} /></p>
            <footer className="lp2-ev__cites">
              {item.citations.length ? item.citations.map((c, i) => (
                <span key={c} className="lp2-cite"><sup>{i + 1}</sup>{c}</span>
              )) : <span className="lp2-muted">No sources cited in this answer.</span>}
            </footer>
          </article>

          <aside className="lp2-ev__notes" aria-label="What Perceev records from this answer">
            <div className="lp2-ev__note">
              <Users size={16} aria-hidden="true" />
              <div>
                <strong>{youNamed ? `${BRAND} is named` : `${BRAND} is not named`}</strong>
                <span>{rivals.length ? `Rivals named: ${rivals.join(", ")}` : "No rival named either"}</span>
              </div>
            </div>
            <div className="lp2-ev__note">
              <Link2 size={16} aria-hidden="true" />
              <div>
                <strong>{item.citations.length} {item.citations.length === 1 ? "source" : "sources"} cited</strong>
                <span>Each one is a page you can study, outrank, or earn a mention on.</span>
              </div>
            </div>
            <div className="lp2-ev__note">
              <Cpu size={16} aria-hidden="true" />
              <div>
                <strong>Kept word for word</strong>
                <span>The answer text is stored as returned, so a verdict can always be checked against it.</span>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </section>
  );
}
