"use client";

/**
 * The top of the Overview: the home page's hero carried into the workspace.
 *
 * Threads move behind the brand name, the name rises in word by word, and a
 * dial on the right draws one tick per question in the latest scan, lit for
 * each question whose answers named the brand. The dial reads the same
 * `latest_scan` the KPI row reads. With no scan it draws an empty track and an
 * em dash: no tick, count or percentage is ever drawn without a reading.
 */

import dynamic from "next/dynamic";
import { WordReveal } from "@/components/app/motion/WordReveal";
import { RollingNumber } from "@/components/app/motion/RollingNumber";
import { roundedPct, shortDate, scanTimestamp, toNumber } from "./overviewModel";

const Threads = dynamic(() => import("@/components/reactbits/Threads"), { ssr: false });

const R_OUT = 118;
const R_IN = 100;
/* A scan of many questions still draws a readable ring. */
const MAX_TICKS = 120;

function ticksFor(tracked, mentioned) {
  const total = Math.min(MAX_TICKS, Math.max(0, Math.round(tracked)));
  if (!total) return [];
  const lit = Math.round((Math.min(mentioned, tracked) / tracked) * total);
  return Array.from({ length: total }, (_, i) => {
    const a = (i / total) * Math.PI * 2 - Math.PI / 2;
    /* Rounded so server and client print identical attributes. */
    const c = Math.round(Math.cos(a) * 1000) / 1000;
    const s = Math.round(Math.sin(a) * 1000) / 1000;
    return { i, c, s, on: i < lit };
  });
}

export function VerdictDial({ latest, loading = false }) {
  const tracked = toNumber(latest?.prompts_tracked);
  const mentioned = toNumber(latest?.prompts_mentioned);
  const pct = roundedPct(latest?.visibility_pct);
  const counted = tracked !== null && tracked > 0 && mentioned !== null;
  const ticks = counted ? ticksFor(tracked, mentioned) : [];
  const when = scanTimestamp(latest);

  return (
    <figure className="ov-dial" data-testid="overview-dial" aria-busy={loading || undefined} aria-label="AI visibility in the latest scan">
      <div className="ov-dial__ring">
        <svg viewBox="-140 -140 280 280" aria-hidden="true">
          <defs>
            <linearGradient id="ov-sweep" x1="0" x2="1" y1="0" y2="0">
              <stop offset="0" stopColor="currentColor" stopOpacity="0" />
              <stop offset="1" stopColor="currentColor" stopOpacity="0.5" />
            </linearGradient>
          </defs>
          <circle r={R_OUT + 10} className="ov-dial__track" />
          {ticks.length ? (
            ticks.map((t) => (
              <line
                key={t.i}
                className="ov-dial__tick"
                data-on={t.on ? "true" : "false"}
                style={{ animationDelay: `${200 + t.i * (900 / ticks.length)}ms` }}
                x1={t.c * R_IN}
                y1={t.s * R_IN}
                x2={t.c * R_OUT}
                y2={t.s * R_OUT}
              />
            ))
          ) : (
            <circle r={(R_IN + R_OUT) / 2} className="ov-dial__empty" />
          )}
          {ticks.length ? (
            <g className="ov-dial__sweep">
              <line x1="0" y1="0" x2={R_OUT + 10} y2="0" stroke="url(#ov-sweep)" strokeWidth="1" />
            </g>
          ) : null}
        </svg>
        <div className="ov-dial__center">
          <span className="ov-dial__label">AI visibility</span>
          <span className="ov-dial__value">
            {pct === null ? "—" : <RollingNumber>{String(pct)}</RollingNumber>}
            {pct === null ? null : <small>%</small>}
          </span>
        </div>
      </div>
      <figcaption className="ov-dial__caption">
        {loading ? (
          "Reading your latest scan"
        ) : counted ? (
          <>
            Named in <b>{mentioned}</b> of <b>{tracked}</b> questions
            <span> · {shortDate(when)}</span>
          </>
        ) : latest ? (
          <>Latest scan<span> · {shortDate(when)}</span></>
        ) : (
          "No scan yet"
        )}
      </figcaption>
    </figure>
  );
}

export default function OverviewHero({ eyebrow, name, description, actions, latest, loading, ready, busy }) {
  return (
    <section className="ov-hero" aria-labelledby="ov-hero-title">
      <div className="ov-hero__threads" aria-hidden="true">
        <Threads
          color={[0.96, 0.96, 0.97]}
          amplitude={1}
          distance={0.25}
          lineCount={26}
          maxRenderDim={1100}
          maxSegments={220}
          thickness={0.45}
          speed={busy ? 0.7 : 0.28}
          brightness={0.85}
          opacity={0.5}
          angle={14}
          enableMouseInteraction
        />
      </div>
      <div className="ov-hero__veil" aria-hidden="true" />

      <div className="ov-hero__grid">
        <div className="ov-hero__copy">
          {eyebrow ? <p className="app-eyebrow">{eyebrow}</p> : null}
          <h1 id="ov-hero-title" className="ov-hero__title">
            {ready ? <WordReveal text={name} step={60} /> : <span className="ov-hero__placeholder skeleton-shimmer" aria-label="Loading" />}
          </h1>
          {description ? <p className="app-subtitle">{description}</p> : null}
          {actions ? <div className="app-page-actions ov-hero__actions">{actions}</div> : null}
        </div>
        <VerdictDial latest={latest} loading={loading} />
      </div>
    </section>
  );
}
