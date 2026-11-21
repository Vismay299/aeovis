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
import { Gauge } from '@/components/perceev/charts/Gauge';

/** A finite number, or a numeric string, or nothing. Anything else is not a reading. */
const finite = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
};

const unmeasured = (state, reason) => ({ measured: false, value: '—', state, reason });

/**
 * How the rail's "the same N questions go to each" figure reads. R2.7.9.
 *
 * THE BUG. This was one line — `const perEngine = total ?? (engines[0]?.asked ?? 0)` —
 * so a rail handed no total, or an engine list with no `asked` on it, rendered
 * "The same 0 questions go to each" to a prospect on the LANDING page: a
 * confident figure standing in for a measurement nobody took. It was latent
 * rather than visible, because src/app/page.js happens to pass `total` on every
 * render today; one caller dropping that prop was all that stood between the
 * fabricated zero and the marketing surface. Standing rule 5 — an absent figure
 * is an em dash plus a state, never a zero, which is itself a reading.
 *
 * THREE STATES, KEPT APART ON PURPOSE:
 *   - MEASURED, non-zero: the number, no chip. Nothing to explain.
 *   - MEASURED ZERO: the number `0`, plus a "none asked" chip — a real reading
 *     of nothing, which must not look like the absent case and must not look
 *     like a healthy one either.
 *   - ABSENT / UNREADABLE: an em dash plus a state chip, and a sentence that
 *     stops claiming the set has a size.
 *
 * WHY THE ENGINE-DERIVED FALLBACK GOT STRICTER. The old fallback took
 * `engines[0].asked` and printed it after the words "the same": true only when
 * every engine really was asked the same number. Where they disagree that is a
 * fabrication of the same class as the zero, just harder to spot, so the
 * derivation now requires agreement and reports `engines disagree` otherwise. A
 * caller that wants to under-claim across an uneven split does what page.js
 * already does and passes the minimum in `total` deliberately.
 *
 * `total` is authoritative when present: a caller that computed a figure is not
 * second-guessed against the engine rows.
 *
 * @param {{total?: unknown, engines?: unknown}} props
 * @returns {{measured: boolean, value: string, state: string|null, reason: string|null}}
 */
export function describeRailTotal({ total, engines } = {}) {
  if (total !== undefined && total !== null) {
    const n = finite(total);
    if (n === null || n < 0) {
      return unmeasured(
        'unreadable',
        'the rail was handed a per-engine total that is not a number it can print',
      );
    }
    return {
      measured: true,
      value: String(n),
      state: n === 0 ? 'none asked' : null,
      reason: n === 0 ? 'the set behind this rail is empty' : null,
    };
  }

  const list = Array.isArray(engines) ? engines : [];
  if (list.length === 0) {
    return unmeasured('not measured', 'no total was passed and there are no engine rows to read');
  }

  const asked = list.map((engine) => finite(engine?.asked));
  if (asked.some((a) => a === null)) {
    return unmeasured(
      'not measured',
      'no total was passed and at least one engine row carries no question count',
    );
  }
  const first = asked[0];
  if (asked.some((a) => a !== first)) {
    return unmeasured(
      'engines disagree',
      'the engine rows were asked different numbers of questions, so no single figure is "the same" for each',
    );
  }
  return {
    measured: true,
    value: String(first),
    state: first === 0 ? 'none asked' : null,
    reason: first === 0 ? 'the set behind this rail is empty' : null,
  };
}

export function EngineRail({ engines, notes = [], total }) {
  const perEngine = describeRailTotal({ total, engines });

  return (
    <div className="rail">
      <div className="shell rail__in">
        <div className="rail__top">
          <span className="tag tag--brand">Reach, engine by engine</span>
          <p style={{ fontSize: '14.5px', color: 'var(--ink-3)', flex: '1 1 300px', minWidth: 0 }}>
            {perEngine.measured ? (
              <>
                The same <span className="num">{perEngine.value}</span> questions go to each.
              </>
            ) : (
              <>
                Every engine gets the same set; its size here is{' '}
                <span className="num">{perEngine.value}</span>
              </>
            )}
            {perEngine.state ? (
              <>
                {' '}
                <span className="tag" data-rail-total-state={perEngine.state} title={perEngine.reason ?? undefined}>
                  {perEngine.state}
                </span>
                .
              </>
            ) : null}{' '}
            The mark is where you land; the line is half the set.
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
