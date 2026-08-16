'use client';

/**
 * The capability deck.
 *
 * Scroll drives it — never a click, never a timer. The section is taller than
 * the viewport and the panel inside pins, so travel through that extra height
 * maps onto the slide index: scroll down and it advances, scroll back and it
 * reverses.
 *
 * Slides move on the Y axis only. A slide earlier in the sequence rests above,
 * a later one below, so direction reverses for free without tracking scroll
 * direction. Below 960px, and whenever motion is unwelcome, the pin is dropped
 * and the cards simply stack — nothing depends on a scroll effect to be read.
 */

import { useEffect, useRef, useState } from 'react';
import { Reveal } from '@/components/landing/Reveal';

/* Every slide's graphic sits in a fixed 96px well (`.wcard__viz`), so each
   viewBox is exactly 300×96 and lays itself out to fit.
 *
 * These deliberately do NOT take the `.chart` class. `.chart` sets
 * `height: auto` so a panel chart honours its own viewBox ratio — which here
 * overrides the height attribute and lets the graphic grow past the well and
 * sit on top of the heading. A fixed well needs a fixed height. */
const VIZ_W = 300;
const VIZ_H = 96;

const vizProps = (label) => ({
  viewBox: `0 0 ${VIZ_W} ${VIZ_H}`,
  width: '100%',
  height: VIZ_H,
  preserveAspectRatio: 'xMinYMid meet',
  style: { display: 'block', width: '100%', height: VIZ_H },
  role: 'img',
  'aria-label': label,
});

function TrackedSetViz({ count }) {
  const cols = 12;
  const rows = Math.ceil(count / cols);
  const step = VIZ_W / cols;          /* 25 at twelve across */
  const gap = 7;
  const top = 8;
  /* derive the mark height from the space available, so a larger tracked set
     shrinks the marks instead of spilling out of the well */
  const markH = Math.min(22, (VIZ_H - top * 2 - (rows - 1) * gap) / rows);
  const marks = Array.from({ length: count }, (_, i) => ({
    x: (i % cols) * step,
    y: top + Math.floor(i / cols) * (markH + gap),
  }));
  return (
    <svg {...vizProps(`The tracked set: ${count} questions`)}>
      <g fill="var(--card-brand-soft)" opacity=".55">
        {marks.map((m, i) => (
          <rect key={i} x={m.x} y={m.y} width={step - 4} height={markH} rx="4" />
        ))}
      </g>
    </svg>
  );
}

function TrendViz() {
  return (
    <svg {...vizProps("Share of AI rising over six readings, while the rival's falls")}>
      <path
        d="M4 82 L62 74 L120 60 L178 63 L236 40 L296 14" fill="none"
        stroke="var(--card-brand-ink)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
      />
      <path
        d="M4 40 L62 44 L120 52 L178 50 L236 62 L296 66" fill="none"
        stroke="var(--card-brand-soft)" strokeWidth="1.6" strokeDasharray="4 4" opacity=".7"
      />
      <circle cx="296" cy="14" r="4" fill="var(--card-brand-ink)" />
    </svg>
  );
}

function RivalViz() {
  const bars = [
    { w: 118, fill: 'var(--card-brand-ink)', o: 1 },
    { w: 96, fill: 'var(--card-brand-soft)', o: 0.75 },
    { w: 50, fill: 'var(--card-brand-soft)', o: 0.5 },
    { w: 28, fill: 'var(--card-brand-soft)', o: 0.3 },
  ];
  return (
    <svg {...vizProps('Rival share of answers, you first')}>
      {bars.map((b, i) => (
        <rect key={i} x="0" y={8 + i * 24} width={b.w} height="14" rx="3" fill={b.fill} opacity={b.o} />
      ))}
    </svg>
  );
}

function SourcesViz({ total, mine }) {
  /* Four rows, as many columns as it takes to show every source. The card
     claims 64 pages, so all 64 are drawn — a truncated field would make the
     picture disagree with the sentence under it. */
  const rows = 4;
  const cols = Math.ceil(total / rows);
  const xStep = VIZ_W / cols;
  const yStep = VIZ_H / rows;
  const r = Math.min(5, xStep / 2 - 1.5);
  const dots = Array.from({ length: total }, (_, i) => ({
    cx: xStep / 2 + (i % cols) * xStep,
    cy: yStep / 2 + Math.floor(i / cols) * yStep,
  }));
  /* pick exactly `mine` of them, spread evenly through the field */
  const mineIdx = new Set(
    Array.from({ length: mine }, (_, k) => Math.floor((k + 0.5) * (total / mine))),
  );
  return (
    <svg {...vizProps(`${total} cited sources, ${mine} of them yours`)}>
      <g fill="var(--card-brand-soft)" opacity=".34">
        {dots.map((d, i) => (mineIdx.has(i) ? null : <circle key={i} cx={d.cx} cy={d.cy} r={r} />))}
      </g>
      <g fill="var(--card-brand-ink)">
        {dots.map((d, i) => (mineIdx.has(i) ? <circle key={i} cx={d.cx} cy={d.cy} r={r} /> : null))}
      </g>
    </svg>
  );
}

export function CapabilityDeck({ slides, children }) {
  const sectionRef = useRef(null);
  const [current, setCurrent] = useState(0);

  useEffect(() => {
    const sec = sectionRef.current;
    if (!sec) return undefined;

    const pinned = () =>
      window.matchMedia('(min-width:961px)').matches
      && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const onScroll = () => {
      if (!pinned()) { setCurrent(0); return; }
      const top = sec.getBoundingClientRect().top;
      const range = sec.offsetHeight - window.innerHeight;
      if (range <= 0) return;
      const p = Math.min(1, Math.max(0, -top / range));
      /* p spans the whole section, so the index is which nth of it we are in */
      setCurrent(Math.min(slides.length - 1, Math.floor(p * slides.length)));
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    onScroll();
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [slides.length]);

  return (
    <section className="workscroll" id="work" ref={sectionRef}>
      <div className="workscroll__pin">
        <div className="shell work">
          <div className="work__side">
            <Reveal>{children}</Reveal>
          </div>

          <Reveal className="deck">
            <div className="deck__stage">
              {slides.map((s, i) => (
                <article
                  key={s.title}
                  className={`wcard ${i === current ? 'is-on' : i < current ? 'is-prev' : 'is-next'}`}
                  aria-roledescription="slide"
                  aria-hidden={i !== current ? 'true' : undefined}
                >
                  <span className="wcard__n">
                    {String(i + 1).padStart(2, '0')} / {String(slides.length).padStart(2, '0')}
                  </span>
                  <div className="wcard__viz">{s.viz}</div>
                  <h3>{s.title}</h3>
                  <p>{s.body}</p>
                </article>
              ))}
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

export { TrackedSetViz, TrendViz, RivalViz, SourcesViz };
export default CapabilityDeck;
