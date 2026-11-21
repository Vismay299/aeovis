"use client";

import { Marquee } from "@/components/magicui/marquee";
import { QUESTIONS } from "./sample";

const half = Math.ceil(QUESTIONS.length / 2);
const ROW_A = QUESTIONS.slice(0, half);
const ROW_B = QUESTIONS.slice(half);

function Row({ items, reverse }) {
  return (
    <Marquee reverse={reverse} pauseOnHover repeat={3} className="lp2-band__row">
      {items.map((q) => (
        <span key={q.id} className="lp2-band__q">
          <span className="lp2-band__glyph" aria-hidden="true">?</span>
          {q.q}
        </span>
      ))}
    </Marquee>
  );
}

export default function QuestionBand() {
  return (
    <section className="lp2-band" aria-label="Sample buyer questions">
      <p className="lp2-band__label lp2-eyebrow">
        Questions buyers actually type. Not one of them names a vendor.
      </p>
      <div className="lp2-band__rows" aria-hidden="true">
        <Row items={ROW_A} />
        <Row items={ROW_B} reverse />
      </div>
    </section>
  );
}
