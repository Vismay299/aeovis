/**
 * A rotary selector. The indicator is an engraved position mark — two
 * nickel chevrons scribed into the panel beside the window, not a
 * software chevron floating over a field.
 */

export const Select = ({
  label,
  id,
  size = 'md',
  hint,
  children,
  className = '',
  style: outerStyle,
  ...props
}) => (
  <div className={className} style={outerStyle}>
    {label && (
      <label htmlFor={id} className="t-plate" style={{ display: 'block', marginBottom: 'var(--space-2)' }}>
        {label}
      </label>
    )}
    <div style={{ position: 'relative' }}>
      <select
        id={id}
        className={`sb-field sb-select${size !== 'md' ? ` sb-field--${size}` : ''}`}
        {...props}
      >
        {children}
      </select>
      <svg
        width="9"
        height="14"
        viewBox="0 0 9 14"
        aria-hidden="true"
        style={{
          position: 'absolute',
          right: '12px',
          top: '50%',
          transform: 'translateY(-50%)',
          pointerEvents: 'none',
        }}
      >
        <path d="M1 5.5 4.5 2 8 5.5" stroke="var(--nickel-dim)" strokeWidth="1.4" fill="none" />
        <path d="M1 8.5 4.5 12 8 8.5" stroke="var(--nickel)" strokeWidth="1.4" fill="none" />
      </svg>
    </div>
    {hint && (
      <p style={{ marginTop: 'var(--space-2)', font: 'var(--type-body-sm)', color: 'var(--text-3)' }}>
        {hint}
      </p>
    )}
  </div>
);

export default Select;
