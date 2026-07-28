/** A recessed field cut into the panel face, with its engraved plate. */

export const Input = ({
  label,
  error,
  hint,
  id,
  size = 'md',
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
    <input
      id={id}
      className={`sb-field${size !== 'md' ? ` sb-field--${size}` : ''}`}
      aria-invalid={error ? 'true' : undefined}
      aria-describedby={error && id ? `${id}-err` : undefined}
      {...props}
    />
    {error ? (
      <p
        id={id ? `${id}-err` : undefined}
        style={{ marginTop: 'var(--space-2)', font: 'var(--type-body-sm)', color: 'var(--lamp-red-text)' }}
      >
        {error}
      </p>
    ) : (
      hint && (
        <p style={{ marginTop: 'var(--space-2)', font: 'var(--type-body-sm)', color: 'var(--text-3)' }}>
          {hint}
        </p>
      )
    )}
  </div>
);

export default Input;
