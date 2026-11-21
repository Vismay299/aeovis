"use client";

import { useRef } from "react";
import { useGsap, gsap, Flip } from "./motion";
import { QUESTIONS, DESTINATIONS, QUESTION_COUNT, ENGINE_SENTENCE_LIST } from "./sample";

const COLUMN = Object.fromEntries(DESTINATIONS.map((d, i) => [d.key, i + 1]));

const PHASES = [
  { n: "01", h: "Ask", p: `${QUESTION_COUNT} buyer questions, sourced for your category. None of them contain your name.` },
  { n: "02", h: "Read", p: `Every question goes to ${ENGINE_SENTENCE_LIST}. Each answer is kept word for word.` },
  { n: "03", h: "Sort", p: "Each answer lands with whoever it recommends: you, a rival, or nobody." },
];

export default function Sorting() {
  const root = useRef(null);

  useGsap(root, ({ reduced }) => {
    const board = root.current.querySelector(".lp2-sort__board");
    const chips = gsap.utils.toArray(".lp2-q", board);
    const phases = gsap.utils.toArray(".lp2-sort__phase");

    if (reduced) {
      board.classList.add("is-sorted", "is-colored");
      return;
    }

    const mm = gsap.matchMedia();

    mm.add("(min-width: 960px)", () => {
      board.classList.remove("is-sorted", "is-colored");
      const state = Flip.getState(chips);
      board.classList.add("is-sorted");

      const flip = Flip.from(state, {
        duration: 1,
        ease: "power3.inOut",
        stagger: { each: 0.012, from: "random" },
        nested: true,
      });

      gsap.set(phases, { opacity: 0.22 });
      gsap.set(phases[0], { opacity: 1 });
      gsap.set(".lp2-sort__colhead", { opacity: 0, y: 12 });

      const tl = gsap.timeline({
        defaults: { ease: "none" },
        scrollTrigger: {
          trigger: ".lp2-sort__pin",
          start: "top top",
          end: "+=260%",
          pin: true,
          scrub: true,
        },
      });

      tl.from(chips, { opacity: 0, scale: 0.6, y: 30, stagger: { each: 0.02, from: "center" }, duration: 0.4, ease: "power2.out" }, 0)
        .to(phases[0], { opacity: 0.22, duration: 0.1 }, 0.7)
        .to(phases[1], { opacity: 1, duration: 0.1 }, 0.7)
        .fromTo(".lp2-sort__sweep", { xPercent: -10, opacity: 0 }, { xPercent: 110, opacity: 1, duration: 0.8 }, 0.75)
        .to(chips, { "--answered": 1, stagger: { each: 0.015, from: "start" }, duration: 0.2 }, 0.8)
        .set(".lp2-sort__sweep", { opacity: 0 }, 1.6)
        .to(phases[1], { opacity: 0.22, duration: 0.1 }, 1.7)
        .to(phases[2], { opacity: 1, duration: 0.1 }, 1.7)
        .add(flip, 1.75)
        .add(() => board.classList.toggle("is-colored", tl.scrollTrigger.direction > 0), 2.6)
        .to(".lp2-sort__colhead", { opacity: 1, y: 0, stagger: 0.08, duration: 0.3 }, 2.5)
        .to({}, { duration: 0.5 });

      return () => board.classList.add("is-sorted", "is-colored");
    });

    mm.add("(max-width: 959px)", () => {
      board.classList.add("is-sorted", "is-colored");
      gsap.from(chips, {
        opacity: 0, y: 14, stagger: 0.025, duration: 0.6, ease: "power2.out",
        scrollTrigger: { trigger: board, start: "top 80%" },
      });
    });
  });

  return (
    <section ref={root} id="probe" className="lp2-sort" aria-labelledby="lp2-sort-title">
      <div className="lp2-sort__pin">
        <div className="lp2-wrap">
          <div className="lp2-sort__top">
            <div>
              <p className="lp2-eyebrow">How it works</p>
              <h2 id="lp2-sort-title" className="lp2-h2">
                {QUESTION_COUNT} questions in.<br /><span className="lp2-dim">One verdict out.</span>
              </h2>
            </div>
            <ol className="lp2-sort__phases">
              {PHASES.map((p) => (
                <li key={p.n} className="lp2-sort__phase">
                  <span className="lp2-sort__n">{p.n}</span>
                  <strong>{p.h}</strong>
                  <span>{p.p}</span>
                </li>
              ))}
            </ol>
          </div>

          <div className="lp2-sort__boardwrap">
            <div className="lp2-sort__heads" aria-hidden="true">
              {DESTINATIONS.map((d) => (
                <div key={d.key} className="lp2-sort__colhead" data-dest={d.key}>
                  <span className="lp2-sort__colname">{d.label}</span>
                  <span className="lp2-sort__colcount">{d.answers}<small> / {QUESTION_COUNT}</small></span>
                </div>
              ))}
            </div>
            <ul className="lp2-sort__board is-sorted is-colored" aria-label="Sample questions sorted by the brand each answer named">
              <li className="lp2-sort__sweep" aria-hidden="true" />
              {QUESTIONS.map((q) => (
                <li
                  key={q.id}
                  className="lp2-q"
                  data-dest={q.won}
                  style={{ "--col": COLUMN[q.won] }}
                  title={q.q}
                >
                  <span className="lp2-q__dot" aria-hidden="true" />
                  <span className="lp2-q__text">{q.q}</span>
                </li>
              ))}
            </ul>
            <p className="lp2-sort__note">
              Sample report. Brightwave, NorthPeak and Lumen IQ are fictional; the questions are the sample set.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
