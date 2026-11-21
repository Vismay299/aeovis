'use client';

/**
 * Engine coverage.
 *
 * A position on a shared scale, read as a hairline, a filled segment and a
 * dot, with a tick at the halfway threshold. This replaced a row of twelve
 * identical blocks per engine, which read as decoration rather than data.
 *
 * The dot's arrival is the one moment of movement, and it does not overshoot.
 */

export function Gauge({ name, reached, asked, delay = 0, revealed = true }) {
  /**
   * R2.8.2 — a zero-row engine is a real absence, not a measured zero.
   * Rendering "0 / 0" would claim the engine was probed and found nothing;
   * "no data" says it was never asked.
   */
  if (!asked || asked === 0) {
    return (
      <div className={`gauge${revealed ? ' is-in' : ''}`} style={{ '--p': 0, '--d': `${delay}ms` }}>
        <span className="gauge__n">{name}</span>
        <span className="gauge__t">
          <i className="gauge__half" />
          <i className="gauge__f" />
          <i className="gauge__d" />
        </span>
        <span className="gauge__v dim" data-testid="gauge-no-data">no data</span>
      </div>
    );
  }
  const p = reached / asked;
  return (
    <div className={`gauge${revealed ? ' is-in' : ''}`} style={{ '--p': p, '--d': `${delay}ms` }}>
      <span className="gauge__n">{name}</span>
      <span className="gauge__t">
        <i className="gauge__half" />
        <i className="gauge__f" />
        <i className="gauge__d" />
      </span>
      <span className="gauge__v">{reached} / {asked}</span>
    </div>
  );
}

export default Gauge;
