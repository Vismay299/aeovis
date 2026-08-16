'use client';

/**
 * The ribbon diagram: a tracked set resolving into its destinations.
 *
 * A ribbon carries both the count and the fact that a question ends up
 * somewhere, which the rows of identical blocks this replaced never showed.
 * Ribbon thickness is proportional to answers, so the picture cannot disagree
 * with the numbers printed beside it.
 *
 * `--you` is indigo in every chart, without exception. Rivals ramp down the
 * neutral scale — losing a question is not an error state.
 */

export const RIVAL_RAMP = ['var(--rival-1)', 'var(--rival-2)', 'var(--rival-3)'];

/* Geometry, all in viewBox units. */
const H = 300;      /* height of the left column */
const LX = 8;       /* left column x */
const W = 14;       /* bar width */
const CX = 320;     /* bezier control x */
const LY0 = 30;     /* left column top */
const RY0 = 16;     /* destination column top */
const GAP = 26;     /* air between destinations */
const LABEL_MIN = 40; /* two-line labels collide below this spacing */

export function FlowDiagram({
  total,
  destinations,
  setLabel = 'TRACKED SET',
  rightX = 620,
  width = 940,
  className = '',
}) {
  const shown = destinations.filter((d) => d.answers > 0);
  if (!total || shown.length === 0) return null;

  const unit = H / total;

  /* Walk both columns at once: the left drains in set order, the right opens
     a gap between each destination so the labels have room. */
  let ly = LY0;
  let ry = RY0;
  const bands = shown.map((d) => {
    const h = d.answers * unit;
    const band = { ...d, l0: ly, l1: ly + h, r0: ry, r1: ry + h };
    ly += h;
    ry += h + GAP;
    return band;
  });

  /* Anything not yet accounted for sits at the foot of the left column. */
  const placed = shown.reduce((s, d) => s + d.answers, 0);
  const restH = Math.max(0, (total - placed) * unit);

  const height = Math.max(ly + restH, ry) + 24;
  const described = bands.map((b) => `${b.answers} name ${b.label}`).join(', ');

  /* A band of two or three answers is thinner than its own label, so the
     label is pushed clear rather than allowed to sit on its neighbour. */
  let lastLabel = -Infinity;
  const labelled = bands.map((b) => {
    let cy = b.r0 + (b.r1 - b.r0) / 2;
    if (cy - lastLabel < LABEL_MIN) cy = lastLabel + LABEL_MIN;
    lastLabel = cy;
    return { ...b, cy };
  });

  return (
    <div className={`flow ${className}`.trim()}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Of ${total} unbranded questions, ${described}.`}
      >
        <text
          x={LX} y="18" fontSize="10.5" letterSpacing="1.5" fill="var(--ink-3)"
          className="flow__lab" style={{ fontFamily: 'var(--font-mono)' }}
        >
          {setLabel} · {total}
        </text>
        <rect x={LX} y={LY0} width={W} height={H} rx="3" fill="var(--ink-1)" opacity=".14" />

        {labelled.map((b, i) => (
          <path
            key={`rib-${b.key}`}
            className={`flow__rib${b.isYou ? ' flow__rib--you' : ''}`}
            style={{ '--d': `${120 + i * 100}ms` }}
            fill={b.colour}
            d={`M${LX + W},${b.l0} C${CX},${b.l0} ${CX},${b.r0} ${rightX},${b.r0}
                L${rightX},${b.r1} C${CX},${b.r1} ${CX},${b.l1} ${LX + W},${b.l1} Z`}
          />
        ))}

        {labelled.map((b, i) => (
          <rect
            key={`node-${b.key}`}
            className="flow__node"
            style={{ '--d': `${120 + i * 100}ms` }}
            x={rightX} y={b.r0} width={W} height={b.r1 - b.r0} rx="3" fill={b.colour}
          />
        ))}

        {labelled.map((b, i) => (
          <g key={`lab-${b.key}`} className="flow__lab" style={{ '--d': `${120 + i * 100}ms` }}>
            <text
              x={rightX + 30} y={b.cy - 2} fontSize="17" fontWeight="620" letterSpacing="-.3"
              fill={b.muted ? 'var(--ink-3)' : 'var(--ink-1)'}
            >
              {b.label}
            </text>
            <text
              x={rightX + 30} y={b.cy + 20} fontSize="12"
              fill={b.isYou ? 'var(--brand)' : 'var(--ink-3)'}
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              {b.answers} ANSWERS · {Math.round((b.answers / total) * 100)}%
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

export default FlowDiagram;
