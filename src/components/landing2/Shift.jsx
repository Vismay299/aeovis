"use client";

import { useRef } from "react";
import { Search } from "lucide-react";
import { SAMPLE_RESULT, DEMO_SET } from "@/shared/mockData";
import { useGsap, gsap } from "./motion";
import { Tokens, tokenize } from "./markup";
import { BRAND } from "./sample";

/* The first question in the sample set, and the answer the sample recorded. */
const ROW = SAMPLE_RESULT.results[0];
const WINNER = DEMO_SET[0].won === "you" ? BRAND : (ROW.brands || []).find((b) => b.mentioned)?.name;
const TOKENS = tokenize(ROW.text, { youNamed: ROW.visible });
const LINKS = SAMPLE_RESULT.topDomains.slice(0, 10);

const STEPS = [
  { k: "Then", h: "Buyers compared ten links.", p: "They opened tabs, read the reviews, and built a shortlist themselves." },
  { k: "Now", h: "The engine reads them for you.", p: "An answer engine condenses those pages into a single paragraph." },
  { k: "So", h: "It names one brand. Not always yours.", p: "If you are not named in that paragraph, you are not on the shortlist." },
];

export default function Shift() {
  const root = useRef(null);

  useGsap(root, ({ reduced }) => {
    const words = gsap.utils.toArray(".lp2-one__text .lp2-w");
    const marks = gsap.utils.toArray(".lp2-one__text .lp2-mark");
    const steps = gsap.utils.toArray(".lp2-shift__step");

    if (reduced) {
      gsap.set(".lp2-serp__row", { opacity: 0.25 });
      marks.forEach((m) => m.classList.add("is-lit"));
      return;
    }

    const mm = gsap.matchMedia();
    mm.add("(min-width: 960px)", () => {
      gsap.set(steps, { opacity: 0.18 });
      gsap.set(steps[0], { opacity: 1 });
      gsap.set(".lp2-one", { opacity: 0, scale: 0.92, y: 40 });
      gsap.set(words, { opacity: 0.08 });

      const tl = gsap.timeline({
        defaults: { ease: "none" },
        scrollTrigger: {
          trigger: ".lp2-shift__pin",
          start: "top top",
          end: "+=230%",
          pin: true,
          scrub: true,
        },
      });

      tl.to(".lp2-shift__bar i", { scaleY: 1, duration: 3 }, 0)
        .to(steps[0], { opacity: 0.18, duration: 0.2 }, 0.9)
        .to(steps[1], { opacity: 1, duration: 0.2 }, 0.9)
        .to(".lp2-serp__row", {
          y: (i) => (4.5 - i) * 18,
          scaleY: 0.4,
          opacity: 0,
          stagger: { each: 0.05, from: "edges" },
          duration: 0.6,
        }, 0.7)
        .to(".lp2-serp__head", { y: -8, opacity: 0, duration: 0.3 }, 1.1)
        .to(".lp2-serp", { scale: 0.9, opacity: 0, duration: 0.4 }, 1.15)
        .to(".lp2-one", { opacity: 1, scale: 1, y: 0, duration: 0.5, ease: "power2.out" }, 1.15)
        .to(words, { opacity: 1, stagger: 0.012, duration: 0.2 }, 1.4)
        .to(steps[1], { opacity: 0.18, duration: 0.2 }, 2.15)
        .to(steps[2], { opacity: 1, duration: 0.2 }, 2.15)
        .add(() => marks.forEach((m) => m.classList.add("is-lit")), 2.2)
        .fromTo(".lp2-one__verdict", { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.3 }, 2.3)
        .to({}, { duration: 0.4 });

      /* Scrubbing backwards un-lights the marks again. */
      tl.eventCallback("onUpdate", () => {
        const lit = tl.time() >= 2.2;
        marks.forEach((m) => m.classList.toggle("is-lit", lit));
      });
    });

    mm.add("(max-width: 959px)", () => {
      marks.forEach((m) => m.classList.add("is-lit"));
      gsap.from(".lp2-one", { opacity: 0, y: 30, duration: 1, ease: "power3.out", scrollTrigger: { trigger: ".lp2-one", start: "top 85%" } });
    });
  });

  return (
    <section ref={root} id="shift" className="lp2-shift" aria-labelledby="lp2-shift-title">
      <div className="lp2-shift__pin">
        <div className="lp2-wrap lp2-shift__grid">
          <div className="lp2-shift__copy">
            <p className="lp2-eyebrow">Why now</p>
            <h2 id="lp2-shift-title" className="lp2-h2">
              Search gave buyers a list.<br />
              <span className="lp2-dim">AI gives them a verdict.</span>
            </h2>
            <div className="lp2-shift__steps">
              <div className="lp2-shift__bar" aria-hidden="true"><i /></div>
              <ol>
                {STEPS.map((s) => (
                  <li key={s.k} className="lp2-shift__step">
                    <span className="lp2-shift__k">{s.k}</span>
                    <strong>{s.h}</strong>
                    <span>{s.p}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>

          <div className="lp2-shift__stage">
            <div className="lp2-serp" aria-hidden="true">
              <div className="lp2-serp__head">
                <Search size={15} aria-hidden="true" />
                <span>{ROW.prompt}</span>
              </div>
              <ul>
                {LINKS.map((d) => (
                  <li key={d.domain} className="lp2-serp__row">
                    <span className="lp2-serp__fav" />
                    <span className="lp2-serp__domain">{d.domain}</span>
                    <span className="lp2-serp__line" />
                    <span className="lp2-serp__line lp2-serp__line--short" />
                  </li>
                ))}
              </ul>
            </div>

            <article className="lp2-one" aria-label="One answer from the sample report">
              <header className="lp2-one__head">
                <span className="lp2-chip">One answer</span>
                <span className="lp2-chip lp2-chip--ghost">Sample · fictional brands</span>
              </header>
              <p className="lp2-one__q">{ROW.prompt}</p>
              <p className="lp2-one__text"><Tokens tokens={TOKENS} /></p>
              <footer className="lp2-one__verdict">
                <span><b>{WINNER}</b> is recommended</span>
                <span className="lp2-one__absent">{BRAND} is not in the answer</span>
              </footer>
            </article>
          </div>
        </div>
      </div>
    </section>
  );
}
