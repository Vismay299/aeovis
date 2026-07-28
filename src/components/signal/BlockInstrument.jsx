'use client';

/**
 * The block instrument.
 *
 * In a signal cabin the block instrument is the single dial the signalman
 * trusts: a needle against an engraved scale with named zones, telling him
 * the state of the section ahead. Share-of-AI gets that dial. The needle
 * settles with a mechanical overshoot; it never eases politely into place.
 *
 * Replaces the progress ring. See DESIGN.md § Composition rules, § Motion.
 */

import { useEnteredBlock, useTally } from '@/lib/motion';
import { AspectSignal, aspectForScore, LAMP_VAR } from './Lamp';

const SWEEP = 240; /* degrees of scale, -120 to +120 from vertical */

const ZONES = [
  { from: 0, to: 25, lamp: 'red', name: 'danger' },
  { from: 25, to: 50, lamp: 'amber', name: 'caution' },
  { from: 50, to: 100, lamp: 'green', name: 'clear' },
];

const angleFor = (v) => -SWEEP / 2 + (Math.max(0, Math.min(100, v)) / 100) * SWEEP;

/* Round every derived coordinate. Server and client can differ in the last
   float digit of the same trig call, and React reports that as a hydration
   mismatch on the SVG attribute. Three decimals is well past sub-pixel. */
const fix = (n) => Math.round(n * 1000) / 1000;

const polar = (cx, cy, r, deg) => {
  const a = (deg * Math.PI) / 180;
  return [fix(cx + r * Math.sin(a)), fix(cy - r * Math.cos(a))];
};

const arcPath = (cx, cy, r, from, to) => {
  const [x1, y1] = polar(cx, cy, r, angleFor(from));
  const [x2, y2] = polar(cx, cy, r, angleFor(to));
  const large = ((to - from) / 100) * SWEEP > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
};

/**
 * @param value    0-100 share-of-AI
 * @param size     px, square
 * @param caption  what the number counts, in the product's words
 * @param delta    signed change since the previous reading, or null
 */
export function BlockInstrument({
  value = 0,
  size = 300,
  caption = 'share of ai',
  delta = null,
  showAspect = true,
  animate = true,
  className = '',
}) {
  const [ref, entered] = useEnteredBlock({ threshold: 0.35 });
  const shown = useTally(value, animate ? entered : true, 1000);
  const settled = animate ? shown : value;
  const aspect = aspectForScore(value);

  const cx = 100;
  const cy = 100;
  const rRim = 88;
  const rTickOuter = 76;
  const rTickMinor = 68;
  const rTickMajor = 62;
  const rNumeral = 50;

  const ticks = [];
  for (let v = 0; v <= 100; v += 5) {
    const major = v % 25 === 0;
    const [x1, y1] = polar(cx, cy, rTickOuter, angleFor(v));
    const [x2, y2] = polar(cx, cy, major ? rTickMajor : rTickMinor, angleFor(v));
    ticks.push({ v, x1, y1, x2, y2, major });
  }

  return (
    <div ref={ref} className={className} style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <div style={{ position: 'relative', width: size, height: size, maxWidth: '100%' }}>
        <svg viewBox="0 0 200 200" width="100%" height="100%" role="img"
          aria-label={`${caption}: ${Math.round(value)} percent, signal showing ${aspect.name}`}>
          {/* dial face: recessed steel */}
          <circle cx={cx} cy={cy} r={rRim + 6} fill="var(--panel-0)" stroke="var(--rule-2)" strokeWidth="1" />
          <circle cx={cx} cy={cy} r={rRim - 2} fill="var(--panel-1)" stroke="var(--rule-1)" strokeWidth="1" />

          {/* zone arcs on the rim — the named regions of the scale */}
          {ZONES.map((z) => (
            <path
              key={z.name}
              d={arcPath(cx, cy, rRim, z.from, z.to)}
              stroke={LAMP_VAR[z.lamp]}
              strokeWidth="4"
              fill="none"
              opacity={value >= z.from && value < z.to ? 1 : 0.26}
              strokeLinecap="butt"
            />
          ))}

          {/* engraved scale */}
          {ticks.map((t) => (
            <line
              key={t.v}
              x1={t.x1}
              y1={t.y1}
              x2={t.x2}
              y2={t.y2}
              stroke={t.major ? 'var(--nickel)' : 'var(--rule-3)'}
              strokeWidth={t.major ? 1.6 : 1}
            />
          ))}
          {[0, 25, 50, 75, 100].map((v) => {
            const [x, y] = polar(cx, cy, rNumeral, angleFor(v));
            return (
              <text
                key={v}
                x={x}
                y={y}
                fill="var(--text-3)"
                fontSize="10"
                fontWeight="700"
                fontFamily="var(--font-sans)"
                textAnchor="middle"
                dominantBaseline="central"
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {v}
              </text>
            );
          })}

          {/* needle — nickel shaft, lamp-coloured tip, pivoting on the hub */}
          <g
            style={{
              transform: `rotate(${fix(angleFor(settled))}deg)`,
              transformOrigin: '100px 100px',
              transition: 'transform var(--dur-point) var(--ease-point)',
            }}
          >
            <line x1={cx} y1={cy + 14} x2={cx} y2={cy - rTickOuter + 4} stroke="var(--nickel)" strokeWidth="2.5" />
            <line x1={cx} y1={cy - rTickMinor} x2={cx} y2={cy - rTickOuter + 4} stroke={LAMP_VAR[aspect.lamp]} strokeWidth="3.5" />
          </g>
          <circle cx={cx} cy={cy} r="9" fill="var(--panel-3)" stroke="var(--rule-3)" strokeWidth="1" />
          <circle cx={cx} cy={cy} r="3" fill="var(--nickel-dim)" />
        </svg>

        {/* the reading, engraved into the lower face */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: '11%',
            display: 'grid',
            justifyItems: 'center',
            gap: 2,
            pointerEvents: 'none',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 2 }}>
            <span
              className="t-tally"
              style={{ fontSize: size * 0.19, lineHeight: 1, color: 'var(--text-1)' }}
            >
              {Math.round(settled)}
            </span>
            <span className="t-tally" style={{ fontSize: size * 0.075, color: 'var(--text-3)' }}>
              %
            </span>
          </div>
          <span className="t-plate">{caption}</span>
        </div>
      </div>

      {(showAspect || delta != null) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
          {showAspect && <AspectSignal aspect={aspect} size="sm" />}
          {delta != null && Number.isFinite(delta) && delta !== 0 && (
            <span
              className="t-tally"
              style={{
                fontSize: 13,
                color: delta > 0 ? 'var(--lamp-green)' : 'var(--lamp-red)',
              }}
            >
              {delta > 0 ? '+' : '−'}
              {Math.abs(delta).toFixed(1)} since last
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export default BlockInstrument;
