/**
 * An engraved indication plate. Names a state on the panel: which aspect
 * something is showing, who holds a section, what a row is. The plate
 * voice is the world's own label, so this is where it belongs.
 */

const variantStyles = {
  /* aspects */
  strong: { bg: 'var(--lamp-green-soft)', color: 'var(--lamp-green-text)', border: 'var(--lamp-green-edge)' },
  moderate: { bg: 'var(--lamp-amber-soft)', color: 'var(--lamp-amber-text)', border: 'var(--lamp-amber-edge)' },
  weak: { bg: 'var(--lamp-red-soft)', color: 'var(--lamp-red-text)', border: 'var(--lamp-red-edge)' },
  /* roles */
  accent: { bg: 'var(--lamp-green-soft)', color: 'var(--lamp-green-text)', border: 'var(--lamp-green-edge)' },
  good: { bg: 'var(--lamp-green-soft)', color: 'var(--lamp-green-text)', border: 'var(--lamp-green-edge)' },
  warn: { bg: 'var(--lamp-amber-soft)', color: 'var(--lamp-amber-text)', border: 'var(--lamp-amber-edge)' },
  crit: { bg: 'var(--lamp-red-soft)', color: 'var(--lamp-red-text)', border: 'var(--lamp-red-edge)' },
  you: { bg: 'var(--lamp-white-soft)', color: 'var(--lamp-white)', border: 'var(--lamp-white-edge)' },
  rival: { bg: 'var(--lamp-red-soft)', color: 'var(--lamp-red-text)', border: 'var(--lamp-red-edge)' },
  info: { bg: 'var(--lamp-blue-soft)', color: 'var(--lamp-blue-text)', border: 'var(--lamp-blue-edge)' },
  /* unlit */
  neutral: { bg: 'var(--panel-2)', color: 'var(--text-2)', border: 'var(--rule-2)' },
  muted: { bg: 'transparent', color: 'var(--text-3)', border: 'var(--rule-1)' },
};

export const tierVariant = (tier) => {
  const map = { strong: 'strong', moderate: 'moderate', weak: 'weak' };
  return map[tier] || 'neutral';
};

export const Badge = ({ variant = 'neutral', dot, children, className = '' }) => {
  /* Callers pass display-cased tiers ("Strong") as well as keys. */
  const s =
    variantStyles[variant] ||
    variantStyles[String(variant ?? '').trim().toLowerCase()] ||
    variantStyles.neutral;

  return (
    <span
      className={`inline-flex items-center gap-1.5 select-none ${className}`}
      style={{
        background: s.bg,
        color: s.color,
        border: `1px solid ${s.border}`,
        borderRadius: '1px',
        padding: '2px 7px',
        fontFamily: 'var(--font-sans)',
        fontStretch: 'var(--wdth-plate)',
        fontWeight: 700,
        fontSize: '10px',
        textTransform: 'uppercase',
        letterSpacing: '0.13em',
        lineHeight: '16px',
        boxShadow: 'inset 0 1px 0 var(--bevel-hi)',
        whiteSpace: 'nowrap',
      }}
    >
      {dot && (
        <span
          aria-hidden="true"
          style={{
            display: 'inline-block',
            width: '5px',
            height: '5px',
            borderRadius: '50%',
            background: s.color,
            boxShadow: `0 0 6px ${s.color}`,
          }}
        />
      )}
      {children}
    </span>
  );
};

export default Badge;
