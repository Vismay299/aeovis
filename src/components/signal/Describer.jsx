'use client';

/**
 * Train describer — 14-segment berth digits.
 *
 * On a real panel the describer is how the box knows *which* train is in
 * which berth: a four-character reporting number stepping along the route
 * as sections clear. Here it carries probe IDs, scan codes, brand initials
 * and live counts. Digits are drawn, never set in a font, so unlit
 * segments stay faintly visible the way a real display's do.
 *
 * See DESIGN.md § Typography, § Motion.
 */

import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from '@/lib/motion';

/* Segment geometry in a 60x100 cell. Lines, not polygons: a real display
   is made of bars and this keeps the glyph crisp at every size. */
const SEG = {
  a: [11, 8, 49, 8],
  b: [52, 11, 52, 47],
  c: [52, 53, 52, 89],
  d: [11, 92, 49, 92],
  e: [8, 53, 8, 89],
  f: [8, 11, 8, 47],
  g1: [11, 50, 27, 50],
  g2: [33, 50, 49, 50],
  h: [11, 12, 26, 44],
  i: [30, 11, 30, 47],
  j: [49, 12, 34, 44],
  k: [49, 88, 34, 56],
  l: [30, 53, 30, 89],
  m: [11, 88, 26, 56],
};

const ORDER = ['a', 'b', 'c', 'd', 'e', 'f', 'g1', 'g2', 'h', 'i', 'j', 'k', 'l', 'm'];

const GLYPHS = {
  '0': ['a', 'b', 'c', 'd', 'e', 'f'],
  '1': ['b', 'c'],
  '2': ['a', 'b', 'g1', 'g2', 'e', 'd'],
  '3': ['a', 'b', 'c', 'd', 'g1', 'g2'],
  '4': ['f', 'g1', 'g2', 'b', 'c'],
  '5': ['a', 'f', 'g1', 'g2', 'c', 'd'],
  '6': ['a', 'f', 'e', 'd', 'c', 'g1', 'g2'],
  '7': ['a', 'b', 'c'],
  '8': ['a', 'b', 'c', 'd', 'e', 'f', 'g1', 'g2'],
  '9': ['a', 'b', 'c', 'd', 'f', 'g1', 'g2'],
  A: ['a', 'b', 'c', 'e', 'f', 'g1', 'g2'],
  B: ['a', 'b', 'c', 'd', 'g2', 'i', 'l'],
  C: ['a', 'd', 'e', 'f'],
  D: ['a', 'b', 'c', 'd', 'i', 'l'],
  E: ['a', 'd', 'e', 'f', 'g1', 'g2'],
  F: ['a', 'e', 'f', 'g1'],
  G: ['a', 'c', 'd', 'e', 'f', 'g2'],
  H: ['b', 'c', 'e', 'f', 'g1', 'g2'],
  I: ['a', 'd', 'i', 'l'],
  J: ['b', 'c', 'd', 'e'],
  K: ['e', 'f', 'g1', 'j', 'k'],
  L: ['d', 'e', 'f'],
  M: ['b', 'c', 'e', 'f', 'h', 'j'],
  N: ['b', 'c', 'e', 'f', 'h', 'k'],
  O: ['a', 'b', 'c', 'd', 'e', 'f'],
  P: ['a', 'b', 'e', 'f', 'g1', 'g2'],
  Q: ['a', 'b', 'c', 'd', 'e', 'f', 'k'],
  R: ['a', 'b', 'e', 'f', 'g1', 'g2', 'k'],
  S: ['a', 'c', 'd', 'f', 'g1', 'g2'],
  T: ['a', 'i', 'l'],
  U: ['b', 'c', 'd', 'e', 'f'],
  V: ['e', 'f', 'j', 'm'],
  W: ['b', 'c', 'e', 'f', 'k', 'm'],
  X: ['h', 'j', 'k', 'm'],
  Y: ['h', 'j', 'l'],
  Z: ['a', 'j', 'm', 'd'],
  '-': ['g1', 'g2'],
  '/': ['j', 'm'],
  '%': ['h', 'j', 'm', 'k'],
  '?': ['a', 'b', 'g2', 'l'],
  ' ': [],
};

const LAMPS = {
  green: 'var(--lamp-green)',
  white: 'var(--lamp-white)',
  amber: 'var(--lamp-amber)',
  red: 'var(--lamp-red)',
  blue: 'var(--lamp-blue)',
};

const BLOOMS = {
  green: 'var(--lamp-green-bloom)',
  white: 'var(--lamp-white-bloom)',
  amber: 'var(--lamp-amber-bloom)',
  red: 'var(--lamp-red-bloom)',
  blue: '0 0 12px var(--lamp-blue-edge)',
};

function Glyph({ char, size, lamp, stroke }) {
  const lit = GLYPHS[char] ?? GLYPHS['?'];
  const color = LAMPS[lamp] || LAMPS.white;

  return (
    <svg
      viewBox="0 0 60 100"
      width={size * 0.6}
      height={size}
      aria-hidden="true"
      style={{ display: 'block', overflow: 'visible' }}
    >
      {ORDER.map((key) => {
        const [x1, y1, x2, y2] = SEG[key];
        const on = lit.includes(key);
        return (
          <line
            key={key}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke={on ? color : 'var(--rule-1)'}
            strokeWidth={stroke}
            strokeLinecap="butt"
            opacity={on ? 1 : 0.85}
          />
        );
      })}
    </svg>
  );
}

/**
 * @param value   string shown in the berths
 * @param length  fixed berth count; value is padded/truncated to it
 * @param lamp    green | white | amber | red | blue
 * @param size    glyph height in px
 * @param align   'left' | 'right' — right-align counts, left-align codes
 */
export function Describer({
  value = '',
  length,
  lamp = 'white',
  size = 26,
  align = 'left',
  bloom = true,
  label,
  className = '',
  style,
}) {
  const text = String(value ?? '').toUpperCase();
  const n = length ?? text.length ?? 0;
  const padded =
    align === 'right' ? text.slice(-n).padStart(n, ' ') : text.slice(0, n).padEnd(n, ' ');

  const reduced = useReducedMotion();
  const prev = useRef(padded);
  const [stepping, setStepping] = useState(false);

  useEffect(() => {
    if (prev.current === padded) return;
    prev.current = padded;
    if (reduced) return;
    setStepping(true);
    const t = setTimeout(() => setStepping(false), 90);
    return () => clearTimeout(t);
  }, [padded, reduced]);

  const chars = padded.split('');

  return (
    <span
      className={className}
      role="img"
      aria-label={label ?? `${text.trim() || 'blank'} describer`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: Math.max(2, Math.round(size * 0.11)),
        filter: bloom ? `drop-shadow(0 0 ${Math.round(size * 0.28)}px ${LAMPS[lamp]}55)` : 'none',
        ...style,
      }}
    >
      {chars.map((char, i) => (
        <span
          key={i}
          className={stepping ? 'describer-step' : undefined}
          style={{ display: 'block' }}
        >
          <Glyph
            char={char}
            size={size}
            lamp={lamp}
            stroke={Math.max(2.5, Math.round(size * 0.11))}
          />
        </span>
      ))}
    </span>
  );
}

/**
 * A berth: a describer code in its slot on the panel, with the engraved
 * plate that names the slot. This is the list-item primitive of the world.
 */
export function Berth({ code, plate, lamp = 'white', size = 20, occupied = true, className = '' }) {
  return (
    <span
      className={`inline-flex items-center gap-2.5 ${className}`}
      style={{
        padding: '5px 9px 5px 7px',
        background: 'var(--panel-0)',
        border: `1px solid ${occupied ? 'var(--rule-2)' : 'var(--rule-1)'}`,
        borderRadius: '1px',
        boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.55)',
      }}
    >
      <Describer value={occupied ? code : ''} length={String(code).length} lamp={lamp} size={size} />
      {plate && <span className="t-plate">{plate}</span>}
    </span>
  );
}

export default Describer;
