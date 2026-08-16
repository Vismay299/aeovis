/** A labelled select, sharing the text field's shape. */

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
    {label && <label htmlFor={id} className="lbl">{label}</label>}
    <select
      id={id}
      className="inp"
      style={size === 'sm' ? { height: 36, fontSize: 14 } : undefined}
      {...props}
    >
      {children}
    </select>
    {hint && <p style={{ marginTop: 6, fontSize: 13, color: 'var(--ink-3)' }}>{hint}</p>}
  </div>
);

export default Select;
