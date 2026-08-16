/**
 * A notice. The chip names the state; the message sits on the panel ground
 * rather than a coloured field, so a long message stays readable.
 */

const VARIANT = {
  crit: { chip: 'chip chip--crit', label: 'Error', border: 'var(--crit)' },
  warn: { chip: 'chip chip--warn', label: 'Caution', border: 'var(--line)' },
  info: { chip: 'chip chip--you', label: 'Note', border: 'var(--line)' },
  good: { chip: 'chip chip--good', label: 'Clear', border: 'var(--line)' },
};

export const Alert = ({
  variant = 'info',
  title,
  children,
  action,
  onDismiss,
  className = '',
  ...props
}) => {
  const s = VARIANT[variant] || VARIANT.info;

  return (
    <div
      role={variant === 'crit' ? 'alert' : 'status'}
      className={`panel ${className}`.trim()}
      style={{ borderColor: s.border }}
      {...props}
    >
      <div className="panel__h">
        <span className={s.chip}>
          <i className="chip__led" aria-hidden="true" />
          {s.label}
        </span>
        {title && <b>{title}</b>}
        {onDismiss && (
          <button
            type="button"
            className="btn btn--quiet btn--sm"
            onClick={onDismiss}
            style={{ marginLeft: 'auto' }}
          >
            Dismiss
          </button>
        )}
      </div>
      <div className="panel__b">
        <div style={{ color: 'var(--ink-2)', fontSize: 14, lineHeight: 1.6 }}>{children}</div>
        {action && <div style={{ marginTop: 14 }}>{action}</div>}
      </div>
    </div>
  );
};

export default Alert;
