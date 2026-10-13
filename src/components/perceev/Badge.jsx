/**
 * The shared status chip: 24px, sentence case, with an optional status dot.
 *
 * Semantic variants are reserved for states that genuinely are good, caution
 * or critical. A rival never takes one — losing a question is not an error.
 */

const VARIANT = {
  /* score tiers */
  strong: 'chip--good',
  moderate: 'chip--warn',
  weak: 'chip--crit',
  /* roles */
  good: 'chip--good',
  warn: 'chip--warn',
  crit: 'chip--crit',
  accent: 'chip--you',
  you: 'chip--you',
  info: 'chip--you',
  /* rivals and everything unremarkable share the neutral chip */
  rival: '',
  neutral: '',
  muted: '',
};

export const tierVariant = (tier) => {
  const map = { strong: 'strong', moderate: 'moderate', weak: 'weak' };
  return map[tier] || 'neutral';
};

export const Badge = ({ variant = 'neutral', dot, children, className = '' }) => {
  /* Callers pass display-cased tiers ("Strong") as well as keys. */
  const key = VARIANT[variant] !== undefined
    ? variant
    : String(variant ?? '').trim().toLowerCase();
  const mod = VARIANT[key] ?? '';

  return (
    <span className={`chip ${mod} ${className}`.trim()}>
      {dot && <i className="chip__led" aria-hidden="true" />}
      {children}
    </span>
  );
};

export default Badge;
