'use client';

/**
 * THE INTERLOCKING.
 *
 * This is the dashboard's organising graphic, and it replaces the card grid
 * outright. Read left to right: unbranded buyer questions arrive on one
 * approach line per answer engine, pass through the throat, and terminate
 * at whichever brand the engine actually named. Your platform is lit lunar
 * white; a rival holding the section is red; questions that named nobody
 * run into the hatched siding.
 *
 * Interlocking is the argument the product makes: two brands cannot hold
 * the same path in the same answer, so every route that terminates at a
 * rival is a route that could have been yours.
 *
 * Geometry is computed in real pixels from the measured container so track
 * stays at 0/45/90 degrees at every width — the drafting standard of the
 * artifact. Below 760px the diagram becomes a departure board, which is
 * the same world's small-format object.
 *
 * See DESIGN.md § Composition rules, § Motion.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useEnteredBlock, useRouteChain, useReducedMotion } from '@/lib/motion';
import { Describer } from './Describer';
import { Lamp, LAMP_VAR } from './Lamp';
import { TrackCircuit } from './TrackCircuit';

const L_GUTTER = 172;
const R_GUTTER = 236;
const ENGINE_ROW = 46;
const PLATFORM_ROW = 48;
const MIN_WIDE = 760;

/** Horizontal, then a true 45 degree diagonal, then horizontal. */
function routePath(x0, y0, x1, y1, diagAt) {
  const dy = y1 - y0;
  if (dy === 0) return `M ${x0} ${y0} H ${x1}`;
  const run = Math.abs(dy);
  return `M ${x0} ${y0} H ${diagAt} L ${diagAt + run} ${y1} H ${x1}`;
}

function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(0);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setW(node.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  return [ref, w];
}

/**
 * @param engines    [{ key, name, probes, cleared }]  cleared = routes set to you
 * @param platforms  [{ key, name, count, isYou, isNobody }]
 * @param total      probes in the tracked set
 * @param plate      engraved label for the panel
 */
export function RouteDiagram({
  engines = [],
  platforms = [],
  total = 0,
  plate = 'interlocking · this scan',
  className = '',
}) {
  const [ref, width] = useWidth();
  const [enteredRef, entered] = useEnteredBlock({ threshold: 0.2 });
  const reduced = useReducedMotion();

  const roads = platforms.length;
  const lit = useRouteChain(roads, entered, { step: 90, startDelay: 140 });
  const litRoads = reduced ? roads : lit;

  const wide = width >= MIN_WIDE;

  const engineCount = Math.max(engines.length, 1);
  const diagramH = Math.max(engineCount * ENGINE_ROW, roads * PLATFORM_ROW) + 56;

  const engineYs = engines.map(
    (_, i) => diagramH / 2 + (i - (engineCount - 1) / 2) * ENGINE_ROW,
  );
  const platformYs = platforms.map(
    (_, i) => diagramH / 2 + (i - (roads - 1) / 2) * PLATFORM_ROW,
  );

  const mid = diagramH / 2;
  const inner = Math.max(0, width - L_GUTTER - R_GUTTER);
  const xA = L_GUTTER + 6;
  const xB = L_GUTTER + inner * 0.3;
  const maxEngineDy = engineYs.reduce((m, y) => Math.max(m, Math.abs(y - mid)), 0);
  const xC = xB + maxEngineDy;
  const xD = xC + Math.max(34, inner * 0.1);
  const xE = width - R_GUTTER - 12;

  const maxTerminated = platforms.reduce((m, p) => Math.max(m, p.count || 0), 0) || 1;

  return (
    <div className={`sb-panel ${className}`} ref={enteredRef}>
      <div className="sb-panel__head">
        <span className="t-plate">{plate}</span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 14 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Lamp lamp="white" size={7} />
            <span className="t-plate">you</span>
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Lamp lamp="red" size={7} />
            <span className="t-plate">rival holds</span>
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Lamp lamp="white" lit={false} size={7} />
            <span className="t-plate">no route</span>
          </span>
        </span>
      </div>

      <div ref={ref} style={{ position: 'relative' }}>
        {wide ? (
          <div style={{ position: 'relative', height: diagramH }}>
            {/* ---- track geometry ---- */}
            <svg
              width={width}
              height={diagramH}
              viewBox={`0 0 ${width} ${diagramH}`}
              style={{ position: 'absolute', inset: 0 }}
              aria-hidden="true"
            >
              {/* the throat: unlit line work everything runs on */}
              {engineYs.map((y, i) => (
                <path
                  key={`base-e-${i}`}
                  d={routePath(xA, y, xD, mid, xB)}
                  stroke="var(--track-dim)"
                  strokeWidth="1.5"
                  fill="none"
                />
              ))}
              {platformYs.map((y, i) => (
                <path
                  key={`base-p-${i}`}
                  d={routePath(xD, mid, xE, y, xD)}
                  stroke="var(--track-dim)"
                  strokeWidth="1.5"
                  fill="none"
                />
              ))}

              {/* the set routes, lit in the order the chain reaches them */}
              {platforms.map((p, i) => {
                if (i >= litRoads) return null;
                if (!p.count) return null;
                const lamp = p.isNobody ? null : p.isYou ? 'white' : 'red';
                if (!lamp) return null;
                return (
                  <g key={`lit-${p.key}`}>
                    {engineYs.map((y, j) => (
                      <path
                        key={`lit-e-${j}`}
                        d={routePath(xA, y, xD, mid, xB)}
                        stroke={LAMP_VAR[lamp]}
                        strokeWidth={p.isYou ? 2 : 1.5}
                        fill="none"
                        opacity={p.isYou ? 0.5 : 0.2}
                      />
                    ))}
                    <path
                      d={routePath(xD, mid, xE, platformYs[i], xD)}
                      stroke={LAMP_VAR[lamp]}
                      strokeWidth={p.isYou ? 3 : 2}
                      fill="none"
                      style={{
                        filter: `drop-shadow(0 0 6px ${
                          p.isYou ? 'rgba(223,234,255,0.5)' : 'rgba(255,68,54,0.45)'
                        })`,
                        animation: reduced
                          ? 'none'
                          : 'lamp-in var(--dur-lamp) var(--ease-lamp) both',
                      }}
                    />
                  </g>
                );
              })}

              {/* the hatched siding for questions that named nobody */}
              {platforms.map((p, i) =>
                p.isNobody ? (
                  <g key="siding">
                    <path
                      d={routePath(xD, mid, xE, platformYs[i], xD)}
                      stroke="var(--rule-2)"
                      strokeWidth="2"
                      strokeDasharray="5 4"
                      fill="none"
                    />
                  </g>
                ) : null,
              )}

              {/* points at the throat, and the common section between them */}
              <line x1={xC} y1={mid} x2={xD} y2={mid} stroke="var(--track)" strokeWidth="2.5" />
              <circle cx={xC} cy={mid} r="3.5" fill="var(--panel-0)" stroke="var(--nickel)" strokeWidth="1.4" />
              <circle cx={xD} cy={mid} r="3.5" fill="var(--panel-0)" stroke="var(--nickel)" strokeWidth="1.4" />

              {/* buffer stops at every platform end */}
              {platformYs.map((y, i) => (
                <line
                  key={`buffer-${i}`}
                  x1={xE}
                  y1={y - 7}
                  x2={xE}
                  y2={y + 7}
                  stroke="var(--nickel-dim)"
                  strokeWidth="2"
                />
              ))}
            </svg>

            {/* ---- engine approach plates ---- */}
            {engines.map((e, i) => (
              <div
                key={e.key}
                style={{
                  position: 'absolute',
                  left: 0,
                  top: engineYs[i] - 17,
                  width: L_GUTTER - 10,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: 3,
                }}
              >
                <span className="plate">
                  <Lamp lamp={e.cleared > 0 ? 'green' : 'red'} size={7} />
                  <span className="t-plate" style={{ color: 'var(--text-2)' }}>
                    {e.name}
                  </span>
                </span>
                <span className="t-stamp" style={{ paddingLeft: 2, whiteSpace: 'nowrap' }}>
                  {e.cleared}/{e.probes} named you
                </span>
              </div>
            ))}

            {/* ---- the approach describer: the tracked set arriving ---- */}
            <div
              style={{
                position: 'absolute',
                left: L_GUTTER + 10,
                top: mid - 68,
                display: 'flex',
                flexDirection: 'column',
                gap: 5,
              }}
            >
              <span className="t-plate">questions in</span>
              <Describer value={String(total).padStart(4, '0')} lamp="amber" size={22} />
            </div>

            {/* ---- platform roads ---- */}
            {platforms.map((p, i) => {
              const shown = i < litRoads;
              const lamp = p.isNobody ? null : p.isYou ? 'white' : 'red';
              const color = p.isNobody
                ? 'var(--text-3)'
                : p.isYou
                ? 'var(--lamp-white)'
                : 'var(--text-1)';
              return (
                <div
                  key={p.key}
                  style={{
                    position: 'absolute',
                    right: 0,
                    top: platformYs[i] - 19,
                    width: R_GUTTER - 20,
                    opacity: shown ? 1 : 0.28,
                    transition: 'opacity var(--dur-lamp) var(--ease-lamp)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
                    {lamp ? (
                      <Lamp lamp={lamp} lit={shown && p.count > 0} size={8} />
                    ) : (
                      <Lamp lamp="white" lit={false} size={8} />
                    )}
                    <span
                      style={{
                        font: 'var(--type-body-sm)',
                        fontWeight: p.isYou ? 700 : 450,
                        color,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        minWidth: 0,
                      }}
                      title={p.name}
                    >
                      {p.name}
                    </span>
                    <span
                      className="t-tally"
                      style={{ marginLeft: 'auto', fontSize: 15, color }}
                    >
                      {p.count}
                    </span>
                  </div>
                  <TrackCircuit
                    value={shown ? p.count : 0}
                    max={maxTerminated}
                    sections={12}
                    lamp={p.isYou ? 'white' : p.isNobody ? 'white' : 'red'}
                    height={5}
                    animate={false}
                    label={`${p.name}: ${p.count} of ${total} questions`}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          /* ---- departure board: the same panel, small format ---- */
          <div style={{ padding: 'var(--space-4) var(--space-4) var(--space-5)' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-3)',
                paddingBottom: 'var(--space-4)',
                borderBottom: '1px solid var(--rule-1)',
                marginBottom: 'var(--space-3)',
              }}
            >
              <Describer value={String(total).padStart(4, '0')} lamp="amber" size={20} />
              <span className="t-plate">questions in</span>
              <span className="t-stamp" style={{ marginLeft: 'auto' }}>
                {engines.map((e) => e.name).join(' · ')}
              </span>
            </div>

            {platforms.map((p, i) => {
              const lamp = p.isNobody ? 'white' : p.isYou ? 'white' : 'red';
              return (
                <div key={p.key} style={{ padding: '9px 0', borderBottom: '1px solid var(--rule-1)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <Lamp lamp={lamp} lit={!p.isNobody && p.count > 0 && i < litRoads} size={8} />
                    <span
                      style={{
                        font: 'var(--type-body-sm)',
                        fontWeight: p.isYou ? 700 : 450,
                        color: p.isYou ? 'var(--lamp-white)' : p.isNobody ? 'var(--text-3)' : 'var(--text-1)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {p.name}
                    </span>
                    <span className="t-tally" style={{ marginLeft: 'auto', fontSize: 15 }}>
                      {p.count}
                    </span>
                  </div>
                  <TrackCircuit
                    value={p.count}
                    max={maxTerminated}
                    sections={14}
                    lamp={p.isYou ? 'white' : 'red'}
                    height={5}
                    animate={false}
                    label={`${p.name}: ${p.count} of ${total}`}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Builds diagram inputs from a scan result. Tolerates both the snake_case
 * rows the pipeline writes and the camelCase the API sometimes returns.
 */
export function buildInterlocking(result, { maxRivals = 4 } = {}) {
  const rows = (result?.rawResults || result?.nonBrandedResults || []).filter(
    (r) => !(r.is_branded_query ?? r.isBrandedQuery),
  );

  const answered = rows.filter(
    (r) => r.aio_present || r.aioPresent || r.answer_present || r.answerPresent,
  );

  const yours = answered.filter(
    (r) =>
      (r.brand_mentioned_in_text ?? r.brandMentionedInText) ||
      (r.brand_cited ?? r.brandCited),
  ).length;

  /* Rival occupancy: how many answered questions named each rival while
     saying nothing about you. That is the section they took from you. */
  const rivalCounts = new Map();
  answered.forEach((r) => {
    const mine =
      (r.brand_mentioned_in_text ?? r.brandMentionedInText) ||
      (r.brand_cited ?? r.brandCited);
    if (mine) return;
    const named = [
      ...(r.competitors_found_in_text || r.competitorsFoundInText || []),
      ...(r.competitors_cited || r.competitorsCited || []),
    ];
    new Set(named).forEach((n) => rivalCounts.set(n, (rivalCounts.get(n) || 0) + 1));
  });

  /* A brand is never its own rival. Scan data occasionally carries the
     brand back in the competitor list; it must not open a second road. */
  const own = String(result?.brand || '').trim().toLowerCase();
  const isOwn = (name) => own && String(name).trim().toLowerCase() === own;

  /* Fall back to the aggregate competitor table when rows carry no
     per-question rival data. */
  let rivals = [...rivalCounts.entries()]
    .filter(([name]) => !isOwn(name))
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxRivals)
    .map(([name, count]) => ({ key: `rival-${name}`, name, count, isYou: false }));

  if (rivals.length === 0 && Array.isArray(result?.competitors)) {
    const seen = new Set();
    rivals = result.competitors
      .filter((c) => {
        const k = String(c.name).trim().toLowerCase();
        if (!k || isOwn(c.name) || seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, maxRivals)
      .map((c) => ({
        key: `rival-${c.name}`,
        name: c.name,
        count: c.prompts ?? c.mentions ?? 0,
        isYou: false,
      }));
  }

  const nobody = Math.max(0, answered.length - yours - rivals.reduce((s, r) => s + r.count, 0));

  const platforms = [
    { key: 'you', name: result?.brand || 'Your brand', count: yours, isYou: true },
    ...rivals,
    { key: 'nobody', name: 'No brand named', count: nobody, isNobody: true },
  ];

  /* Engines: whatever actually reported, never a hardcoded list. */
  const ENGINE_NAMES = {
    google_ai_overview: 'AI Overview',
    aio: 'AI Overview',
    perplexity: 'Perplexity',
    openai: 'ChatGPT',
    gemini: 'Gemini',
  };

  const total = rows.length || result?.promptsAnalyzed || result?.promptsTracked || 0;

  const engineKeys = Object.keys(result?.engineScores || {});
  const engines = (engineKeys.length ? engineKeys : ['aio']).map((k) => {
    const of = rows.filter((r) => (r.engine || 'aio') === k);
    const scoped = of.length ? of : rows;
    const cleared = scoped.filter(
      (r) =>
        (r.brand_mentioned_in_text ?? r.brandMentionedInText) ||
        (r.brand_cited ?? r.brandCited),
    ).length;
    return {
      key: k,
      name: ENGINE_NAMES[k] || k.replace(/_/g, ' '),
      /* With no per-question rows on hand (a stored summary, or the sample
         report) fall back to the set size rather than reporting zero asked. */
      probes: scoped.length || Math.round(total / (engineKeys.length || 1)),
      cleared: scoped.length ? cleared : yours,
    };
  });

  return { engines, platforms, total };
}

export default RouteDiagram;
