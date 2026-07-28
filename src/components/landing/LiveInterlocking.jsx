'use client';

/**
 * The mechanism, running.
 *
 * A question arrives, the route is called, and illumination travels along it
 * section by section until it reaches whichever brand the engine actually
 * named. Interlocking is the argument: only one road can hold the path, so
 * every route that terminates at a rival is one that could have been yours.
 *
 * Presentational only — the cycle lives in probeCycle.js so the control
 * column's record and this diagram stay in step.
 */

import { Describer } from '@/components/signal/Describer';
import { Lamp } from '@/components/signal/Lamp';
import { PLATFORMS, SECTIONS, YOU } from './probeCycle';

const ROW = 52;
const FAN_X = 96;

export function LiveInterlocking({ probe, lit, reduced }) {
  const rows = PLATFORMS.length;
  const height = rows * ROW;
  const entryY = height / 2;

  const destIndex = probe.to === null ? rows - 1 : PLATFORMS.indexOf(probe.to);

  return (
    <div className="lp-ilk">
      <div className="lp-ilk-head">
        <Describer value={probe.code} lamp="amber" size={18} />
        <p className="lp-ilk-q">&ldquo;{probe.q}&rdquo;</p>
        <span className="t-plate lp-ilk-engine">{probe.engine}</span>
      </div>

      <div className="lp-ilk-body" style={{ height }}>
        <svg
          viewBox={`0 0 1000 ${height}`}
          preserveAspectRatio="none"
          width="100%"
          height={height}
          aria-hidden="true"
          className="lp-ilk-svg"
        >
          {/* the approach */}
          <path d={`M 0 ${entryY} H ${FAN_X}`} stroke="var(--track-dim)" strokeWidth="2" fill="none" />

          {/* unlit line work: one road per platform */}
          {PLATFORMS.map((_, i) => {
            const y = i * ROW + ROW / 2;
            return (
              <path
                key={`base-${i}`}
                d={`M ${FAN_X} ${entryY} L ${FAN_X + Math.abs(y - entryY)} ${y} H 1000`}
                stroke="var(--track-dim)"
                strokeWidth="1.5"
                fill="none"
              />
            );
          })}

          {/* the set route */}
          {destIndex >= 0 &&
            (() => {
              const y = destIndex * ROW + ROW / 2;
              const isYou = probe.to === YOU;
              const isNobody = probe.to === null;
              const stroke = isNobody
                ? 'var(--rule-3)'
                : isYou
                ? 'var(--lamp-white)'
                : 'var(--lamp-red)';
              const d = `M 0 ${entryY} H ${FAN_X} L ${FAN_X + Math.abs(y - entryY)} ${y} H 1000`;
              return (
                <path
                  d={d}
                  stroke={stroke}
                  strokeWidth={isYou ? 3 : 2}
                  fill="none"
                  strokeDasharray={isNobody ? '7 6' : undefined}
                  style={{
                    clipPath: `inset(0 ${100 - (lit / SECTIONS) * 100}% 0 0)`,
                    transition: reduced ? 'none' : 'clip-path 100ms linear',
                  }}
                />
              );
            })()}

          {/* points at the fan, and buffer stops at every road end */}
          <circle cx={FAN_X} cy={entryY} r="4" fill="var(--panel-1)" stroke="var(--nickel)" strokeWidth="1.5" />
        </svg>

        <div className="lp-ilk-roads">
          {PLATFORMS.map((name, i) => {
            const isDest = i === destIndex;
            const arrived = isDest && lit >= SECTIONS;
            const isYou = name === YOU;
            return (
              <div
                key={name ?? 'nobody'}
                className="lp-ilk-road"
                data-you={isYou ? 'true' : 'false'}
                data-arrived={arrived ? 'true' : 'false'}
                style={{ height: ROW }}
              >
                <span className="lp-ilk-buffer" aria-hidden="true" />
                <Lamp
                  lamp={name === null ? 'amber' : isYou ? 'white' : 'red'}
                  lit={arrived}
                  size={8}
                />
                <span className="lp-ilk-name">{name ?? 'no brand named'}</span>
                <span className="lp-ilk-state t-plate">
                  {arrived ? (name === null ? 'nothing set' : isYou ? 'your route' : 'occupied') : ''}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default LiveInterlocking;
