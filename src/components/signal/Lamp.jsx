'use client';

/**
 * Lamps and aspects.
 *
 * A lamp is the only thing on this surface allowed to bloom, because that
 * is what a lamp does behind glass. The aspect signal is the verdict
 * device: a mast showing DANGER, CAUTION, PRELIMINARY CAUTION or PROCEED,
 * which is the real four-aspect sequence and maps exactly onto a
 * visibility band.
 *
 * See DESIGN.md § Palette, § Composition rules.
 */

const LAMP_VAR = {
  green: 'var(--lamp-green)',
  white: 'var(--lamp-white)',
  amber: 'var(--lamp-amber)',
  red: 'var(--lamp-red)',
  blue: 'var(--lamp-blue)',
};

const BLOOM_VAR = {
  green: 'var(--lamp-green-bloom)',
  white: 'var(--lamp-white-bloom)',
  amber: 'var(--lamp-amber-bloom)',
  red: 'var(--lamp-red-bloom)',
  blue: '0 0 12px var(--lamp-blue-edge)',
};

export function Lamp({ lamp = 'white', lit = true, size = 9, calling = false, className = '', title }) {
  return (
    <span
      title={title}
      aria-hidden={title ? undefined : 'true'}
      className={`lamp lamp--${lamp} ${calling ? 'lamp-call' : ''} ${className}`}
      data-lit={lit ? 'true' : 'false'}
      style={{ width: size, height: size }}
    />
  );
}

/**
 * Aspect bands. The order is the real signalling sequence a driver reads
 * on approach, so the band names carry the meaning without a legend.
 */
export const ASPECTS = {
  danger: { key: 'danger', lamp: 'red', name: 'DANGER', lamps: ['red'] },
  caution: { key: 'caution', lamp: 'amber', name: 'CAUTION', lamps: ['amber'] },
  preliminary: {
    key: 'preliminary',
    lamp: 'amber',
    name: 'PRELIM CAUTION',
    lamps: ['amber', 'amber'],
  },
  proceed: { key: 'proceed', lamp: 'green', name: 'PROCEED', lamps: ['green'] },
};

/** Score (0-100) to the aspect the signal is showing. */
export function aspectForScore(score) {
  if (score == null || !Number.isFinite(score)) return ASPECTS.danger;
  if (score < 8) return ASPECTS.danger;
  if (score < 25) return ASPECTS.caution;
  if (score < 50) return ASPECTS.preliminary;
  return ASPECTS.proceed;
}

/**
 * Tier strings used across the product, mapped to the same sequence.
 * Callers pass both `strong` and the display form `Strong`, so normalise
 * rather than silently falling through to DANGER.
 */
export function aspectForTier(tier) {
  const t = String(tier ?? '').trim().toLowerCase();
  if (t === 'strong') return ASPECTS.proceed;
  if (t === 'moderate') return ASPECTS.preliminary;
  if (t === 'weak') return ASPECTS.caution;
  return ASPECTS.danger;
}

/**
 * A four-aspect head on its mast. Unlit lamps stay visible as dark glass
 * so the aspect reads by position as well as by colour — signalling's own
 * answer to colour-vision deficiency, and ours.
 */
export function AspectSignal({ aspect = ASPECTS.danger, size = 'md', showName = true, className = '' }) {
  const dims = {
    sm: { disc: 11, gap: 5, mast: 2, pad: 5 },
    md: { disc: 16, gap: 7, mast: 3, pad: 7 },
    lg: { disc: 22, gap: 9, mast: 4, pad: 9 },
  }[size] || { disc: 16, gap: 7, mast: 3, pad: 7 };

  /* Head order top to bottom on a British four-aspect head. */
  const heads = ['green', 'amber', 'red', 'amber'];
  const litCount = aspect.lamps.filter((l) => l === 'amber').length;

  const isLit = (head, index) => {
    if (aspect.key === 'proceed') return head === 'green' && index === 0;
    if (aspect.key === 'danger') return head === 'red';
    if (aspect.key === 'caution') return head === 'amber' && index === 1;
    /* preliminary caution shows both ambers */
    return head === 'amber' && litCount === 2;
  };

  return (
    <span className={`inline-flex items-center gap-3 ${className}`}>
      <span
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: dims.gap,
          padding: dims.pad,
          background: 'var(--panel-0)',
          border: '1px solid var(--rule-2)',
          borderRadius: '2px',
          boxShadow: 'inset 0 1px 0 var(--bevel-hi), 0 2px 6px rgba(0,0,0,0.5)',
        }}
      >
        {heads.map((head, i) => {
          const lit = isLit(head, i);
          return (
            <span
              key={`${head}-${i}`}
              style={{
                width: dims.disc,
                height: dims.disc,
                borderRadius: '50%',
                background: lit ? LAMP_VAR[head] : 'var(--panel-3)',
                border: `1px solid ${lit ? LAMP_VAR[head] : 'var(--rule-2)'}`,
                boxShadow: lit ? BLOOM_VAR[head] : 'inset 0 1px 2px rgba(0,0,0,0.6)',
                transition:
                  'background var(--dur-decay) var(--ease-decay), box-shadow var(--dur-decay) var(--ease-decay), border-color var(--dur-decay) var(--ease-decay)',
              }}
            />
          );
        })}
      </span>
      {showName && (
        <span
          className="t-sig"
          style={{
            fontSize: size === 'lg' ? 17 : size === 'sm' ? 11 : 13,
            color: LAMP_VAR[aspect.lamp],
          }}
        >
          {aspect.name}
        </span>
      )}
    </span>
  );
}

export { LAMP_VAR, BLOOM_VAR };
