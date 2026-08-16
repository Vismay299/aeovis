'use client';

/**
 * Engine coverage.
 *
 * A position on a shared scale, read as a line and a dot rather than another
 * row of blocks. The tick at the halfway point is the reference: above it you
 * hold most of that engine's set, below it you do not.
 *
 * Driven by the array it is handed — never a hardcoded count of engines.
 */

import { Reveal } from '@/components/landing/Reveal';
import { Gauge } from '@/components/charts/Gauge';

export function EngineRail({ engines, notes = [], total }) {
  const perEngine = total ?? (engines[0]?.asked ?? 0);

  return (
    <div className="rail">
      <div className="shell rail__in">
        <div className="rail__top">
          <span className="tag tag--brand">Reach, engine by engine</span>
          <p style={{ fontSize: '14.5px', color: 'var(--ink-3)', flex: '1 1 300px', minWidth: 0 }}>
            The same {perEngine} questions go to each. The mark is where you land; the line is half
            the set.
          </p>
        </div>

        {/* The Reveal wrapper carries `is-in`, which is what releases the fill
            and the dot — the gauge itself stays inert until scrolled to. */}
        {engines.map((e, i) => (
          <Reveal key={e.name} delay={i * 110}>
            <Gauge name={e.name} reached={e.reached} asked={e.asked} revealed={false} />
          </Reveal>
        ))}

        {notes.length > 0 && (
          <Reveal className="rail__foot" delay={300}>
            {notes.map((n) => (
              <p key={n}>{n}</p>
            ))}
          </Reveal>
        )}
      </div>
    </div>
  );
}

export default EngineRail;
