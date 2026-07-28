'use client';

/**
 * Track circuits.
 *
 * A track circuit tells the box whether a section of line is occupied. It
 * is discrete, not continuous: a run of sections, each either clear or
 * held. That is what replaces the bar chart here — share reads as "how
 * much of the line you hold", and the route-set threshold is marked on
 * the rail itself.
 *
 * See DESIGN.md § Composition rules.
 */

import { useEnteredBlock, useRouteChain } from '@/lib/motion';
import { LAMP_VAR, BLOOM_VAR } from './Lamp';

/**
 * @param value      units held
 * @param max        total sections of line
 * @param sections   how many discrete sections to draw
 * @param lamp       which lamp holds the line (white = you, red = rival)
 * @param threshold  0-1 position of the route-set mark, or null
 * @param height     rail thickness in px
 */
export function TrackCircuit({
  value = 0,
  max = 100,
  sections = 28,
  lamp = 'white',
  threshold = null,
  height = 10,
  animate = true,
  label,
  className = '',
}) {
  const safeMax = max > 0 ? max : 1;
  const ratio = Math.max(0, Math.min(1, value / safeMax));
  const held = Math.round(ratio * sections);

  const [ref, entered] = useEnteredBlock({ threshold: 0.3 });
  const lit = useRouteChain(held, animate ? entered : true, { step: 26 });
  const shown = animate ? lit : held;

  return (
    <div
      ref={ref}
      className={className}
      role="meter"
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={safeMax}
      aria-label={label}
      style={{ position: 'relative', display: 'flex', gap: 2, alignItems: 'stretch' }}
    >
      {Array.from({ length: sections }).map((_, i) => {
        const on = i < shown;
        return (
          <span
            key={i}
            style={{
              flex: 1,
              height,
              borderRadius: '1px',
              background: on ? LAMP_VAR[lamp] : 'var(--panel-3)',
              boxShadow: on ? BLOOM_VAR[lamp] : 'inset 0 1px 2px rgba(0,0,0,0.5)',
              transition: 'background var(--dur-lamp) var(--ease-lamp)',
            }}
          />
        );
      })}

      {threshold != null && (
        /* The route-set mark: a physical scribe line across the rail. */
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: `${Math.max(0, Math.min(1, threshold)) * 100}%`,
            top: -4,
            bottom: -4,
            width: 0,
            borderLeft: '1px dashed var(--nickel)',
            pointerEvents: 'none',
          }}
        />
      )}
    </div>
  );
}

/**
 * One line of the interlocking's occupancy list: who holds the section,
 * how much of it, and the gap to whoever holds more. Replaces the tally
 * bar wherever brands are compared.
 */
export function OccupancyRow({
  name,
  value,
  max,
  suffix = '%',
  lamp = 'red',
  isYou = false,
  gap,
  rank,
  threshold = null,
  animate = true,
}) {
  const tone = isYou ? 'white' : lamp;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0,1fr) 62px',
        gap: 'var(--space-4)',
        alignItems: 'center',
        padding: 'var(--space-3) 0',
        borderBottom: '1px solid var(--rule-1)',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            marginBottom: 7,
          }}
        >
          {rank != null && (
            <span className="t-plate" style={{ minWidth: 16 }}>
              {String(rank).padStart(2, '0')}
            </span>
          )}
          <span
            style={{
              font: 'var(--type-body-sm)',
              fontWeight: isYou ? 700 : 450,
              color: isYou ? 'var(--lamp-white)' : 'var(--text-1)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {name}
          </span>
          {isYou && (
            <span
              className="t-plate"
              style={{ color: 'var(--lamp-white)', letterSpacing: '0.16em' }}
            >
              you
            </span>
          )}
          {gap != null && gap > 0 && (
            <span className="t-stamp" style={{ marginLeft: 'auto', paddingLeft: 8 }}>
              −{gap}
              {suffix}
            </span>
          )}
        </div>
        <TrackCircuit
          value={value}
          max={max}
          sections={24}
          lamp={tone}
          threshold={threshold}
          height={8}
          animate={animate}
          label={`${name}: ${value}${suffix}`}
        />
      </div>
      <span
        className="t-tally"
        style={{
          fontSize: 19,
          textAlign: 'right',
          color: isYou ? 'var(--lamp-white)' : 'var(--text-1)',
        }}
      >
        {Math.round(value)}
        <span style={{ fontSize: 12, color: 'var(--text-3)', marginLeft: 1 }}>{suffix}</span>
      </span>
    </div>
  );
}

export default TrackCircuit;
