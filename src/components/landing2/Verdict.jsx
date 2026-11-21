"use client";

import { useRef } from "react";
import { GlowingEffect } from "@/components/aceternity/glowing-effect";
import { useGsap, gsap } from "./motion";
import {
  SHARE, WINS, TRACKED, DESTINATIONS, STANDINGS, CITATIONS_TOTAL, CITATIONS_YOURS, TOP_DOMAINS, BRAND,
} from "./sample";

/* One tick per tracked answer, grouped by where it landed. */
const TICKS = DESTINATIONS.flatMap((d) => Array.from({ length: d.answers }, () => d.key));
const R_OUT = 150;
const R_IN = 128;
const MAX_MENTIONS = Math.max(...STANDINGS.map((s) => s.mentions));

/** Digits that roll up into place from below, reading a value they are given. */
function DigitReel({ value }) {
  const digits = String(value).split("");
  return (
    <span className="lp2-reel" aria-label={`${value}%`}>
      {digits.map((d, i) => (
        <span key={i} className="lp2-reel__col" aria-hidden="true">
          <span className="lp2-reel__strip" data-digit={d}>
            {"0123456789".split("").map((n) => <span key={n}>{n}</span>)}
          </span>
        </span>
      ))}
      <span className="lp2-reel__pct" aria-hidden="true">%</span>
    </span>
  );
}

export default function Verdict() {
  const root = useRef(null);

  useGsap(root, ({ reduced }) => {
    const strips = gsap.utils.toArray(".lp2-reel__strip");
    if (reduced) {
      gsap.set(strips, { yPercent: (i, el) => -Number(el.dataset.digit) * 10 });
      gsap.set(".lp2-ring__tick", { opacity: 1 });
      gsap.set(".lp2-bar__fill", { scaleX: 1 });
      return;
    }

    gsap.set(strips, { yPercent: 10 });
    gsap.set(".lp2-ring__tick", { opacity: 0 });
    gsap.set(".lp2-bar__fill", { scaleX: 0 });

    const tl = gsap.timeline({ scrollTrigger: { trigger: ".lp2-verdict__dial", start: "top 72%" } });
    tl.to(".lp2-ring__tick", { opacity: 1, duration: 0.3, stagger: 0.035, ease: "power1.out" }, 0)
      .fromTo(".lp2-ring__sweep", { rotate: -90 }, { rotate: 270, duration: 1.4, ease: "power2.inOut" }, 0)
      .to(strips, {
        yPercent: (i, el) => -Number(el.dataset.digit) * 10,
        duration: 1.6,
        stagger: 0.12,
        ease: "expo.out",
      }, 0.2)
      .from(".lp2-verdict__caption > *", { opacity: 0, y: 10, stagger: 0.1, duration: 0.6, ease: "power2.out" }, 0.8);

    gsap.to(".lp2-bar__fill", {
      scaleX: 1, duration: 1.2, stagger: 0.08, ease: "expo.out",
      scrollTrigger: { trigger: ".lp2-standings", start: "top 80%" },
    });
    gsap.from(".lp2-src__seg", {
      scaleX: 0, transformOrigin: "left center", duration: 0.9, stagger: 0.05, ease: "power3.out",
      scrollTrigger: { trigger: ".lp2-src", start: "top 85%" },
    });
    gsap.from(".lp2-verdict__head > *", {
      opacity: 0, y: 24, stagger: 0.08, duration: 1, ease: "power3.out",
      scrollTrigger: { trigger: root.current, start: "top 70%" },
    });
  });

  return (
    <section ref={root} id="verdict" className="lp2-verdict lp2-section" aria-labelledby="lp2-verdict-title">
      <div className="lp2-wrap">
        <div className="lp2-verdict__head">
          <p className="lp2-eyebrow">The verdict</p>
          <h2 id="lp2-verdict-title" className="lp2-h2">
            One number a CXO reads in a second.
            <span className="lp2-dim"> Every answer behind it, one click away.</span>
          </h2>
        </div>

        <div className="lp2-verdict__grid">
          <div className="lp2-card lp2-verdict__dial">
            <GlowingEffect spread={40} glow disabled={false} proximity={64} inactiveZone={0.01} borderWidth={1} variant="white" />
            <div className="lp2-card__tag"><span className="lp2-chip lp2-chip--ghost">Sample report · {BRAND}</span></div>
            <div className="lp2-ring">
              <svg viewBox="-170 -170 340 340" aria-hidden="true">
                <defs>
                  <linearGradient id="lp2-sweep" x1="0" x2="1" y1="0" y2="0">
                    <stop offset="0" stopColor="#fff" stopOpacity="0" />
                    <stop offset="1" stopColor="#fff" stopOpacity="0.55" />
                  </linearGradient>
                </defs>
                <circle r={R_OUT + 12} className="lp2-ring__track" />
                {TICKS.map((key, i) => {
                  const a = (i / TICKS.length) * Math.PI * 2 - Math.PI / 2;
                  /* Rounded so server and client print identical attributes. */
                  const c = Math.round(Math.cos(a) * 1000) / 1000;
                  const s = Math.round(Math.sin(a) * 1000) / 1000;
                  return (
                    <line
                      key={i}
                      className="lp2-ring__tick"
                      data-dest={key}
                      x1={c * R_IN}
                      y1={s * R_IN}
                      x2={c * R_OUT}
                      y2={s * R_OUT}
                    />
                  );
                })}
                <g className="lp2-ring__sweep">
                  <line x1="0" y1="0" x2={R_OUT + 12} y2="0" stroke="url(#lp2-sweep)" strokeWidth="1" />
                </g>
              </svg>
              <div className="lp2-ring__center">
                <span className="lp2-ring__label">Share of AI</span>
                <DigitReel value={SHARE} />
              </div>
            </div>
            <div className="lp2-verdict__caption">
              <p><b>{BRAND}</b> is named in {WINS} of {TRACKED} answers.</p>
              <ul className="lp2-legend">
                {DESTINATIONS.map((d) => (
                  <li key={d.key} data-dest={d.key}><i aria-hidden="true" />{d.label} <span>{d.answers}</span></li>
                ))}
              </ul>
            </div>
          </div>

          <div className="lp2-verdict__side">
            <div className="lp2-card lp2-standings">
              <GlowingEffect spread={40} glow disabled={false} proximity={64} inactiveZone={0.01} borderWidth={1} variant="white" />
              <h3 className="lp2-h3">Who the engines name instead</h3>
              <p className="lp2-muted">Rivals are discovered from the answers themselves, not from a list you maintain.</p>
              <ul>
                {STANDINGS.map((s) => (
                  <li key={s.name} className="lp2-bar" data-you={s.isYou ? "true" : "false"}>
                    <span className="lp2-bar__name">{s.name}{s.isYou ? <em>you</em> : null}</span>
                    <span className="lp2-bar__track">
                      <span className="lp2-bar__fill" style={{ width: `${(s.mentions / MAX_MENTIONS) * 100}%` }} />
                    </span>
                    <span className="lp2-bar__n">{s.mentions}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="lp2-card lp2-src">
              <GlowingEffect spread={40} glow disabled={false} proximity={64} inactiveZone={0.01} borderWidth={1} variant="white" />
              <h3 className="lp2-h3">The sources behind the answers</h3>
              <p className="lp2-muted">
                {CITATIONS_YOURS} of the {CITATIONS_TOTAL} sources the engines cited are pages you control. The rest is where
                your next piece of content needs to be good enough to replace.
              </p>
              <div className="lp2-src__bar" aria-hidden="true">
                {TOP_DOMAINS.map((d) => (
                  <span
                    key={d.domain}
                    className="lp2-src__seg"
                    data-type={d.type}
                    style={{ flexGrow: d.count }}
                    title={`${d.domain}: ${d.count}`}
                  />
                ))}
              </div>
              <ul className="lp2-src__list">
                {TOP_DOMAINS.slice(0, 6).map((d) => (
                  <li key={d.domain} data-type={d.type}><i aria-hidden="true" />{d.domain}<span>{d.count}</span></li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
