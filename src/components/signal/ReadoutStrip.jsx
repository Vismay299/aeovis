'use client';

/**
 * An instrument bank: a run of readouts on one panel, divided by scribed
 * rules. This is what a row of numbers looks like on real hardware, and it
 * is the replacement for a grid of metric cards — one object, several
 * windows, no floating tiles.
 */

export function ReadoutStrip({ children, columns, plate, className = '', style }) {
  const count = columns ?? (Array.isArray(children) ? children.filter(Boolean).length : 1);

  return (
    <div className={`sb-panel ${className}`} style={style}>
      {plate && (
        <div className="sb-panel__head">
          <span className="t-plate">{plate}</span>
        </div>
      )}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(auto-fit, minmax(${count > 3 ? 168 : 200}px, 1fr))`,
          /* The scribed rules between windows are the grid gaps themselves. */
          gap: '1px',
          background: 'var(--rule-1)',
        }}
      >
        {(Array.isArray(children) ? children : [children]).filter(Boolean).map((child, i) => (
          <div key={i} style={{ background: 'var(--panel-1)' }}>
            {child}
          </div>
        ))}
      </div>
    </div>
  );
}

export default ReadoutStrip;
