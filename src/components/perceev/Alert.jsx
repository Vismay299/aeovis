/**
 * A panel notice. The aspect lamp does the work an icon used to do — it is
 * the world's own way of saying which state you are looking at — and the
 * message sits on a soft field of that lamp's colour.
 */

import { Lamp } from '@/components/signal/Lamp';

const variantStyles = {
  crit: { bg: 'var(--lamp-red-soft)', border: 'var(--lamp-red-edge)', color: 'var(--lamp-red-text)', lamp: 'red', name: 'danger' },
  warn: { bg: 'var(--lamp-amber-soft)', border: 'var(--lamp-amber-edge)', color: 'var(--lamp-amber-text)', lamp: 'amber', name: 'caution' },
  info: { bg: 'var(--lamp-blue-soft)', border: 'var(--lamp-blue-edge)', color: 'var(--lamp-blue-text)', lamp: 'blue', name: 'note' },
  good: { bg: 'var(--lamp-green-soft)', border: 'var(--lamp-green-edge)', color: 'var(--lamp-green-text)', lamp: 'green', name: 'clear' },
};

export const Alert = ({ variant = 'info', title, children, action, onDismiss, className = '' }) => {
  const s = variantStyles[variant] || variantStyles.info;

  return (
    <div
      role={variant === 'crit' ? 'alert' : 'status'}
      className={`flex items-start gap-3 ${className}`}
      style={{
        background: s.bg,
        border: `1px solid ${s.border}`,
        borderRadius: 'var(--radius-1)',
        padding: '12px 14px',
        font: 'var(--type-body-sm)',
      }}
    >
      <span style={{ paddingTop: 4, flexShrink: 0 }}>
        <Lamp lamp={s.lamp} size={9} title={s.name} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {title && (
          <div className="t-plate" style={{ color: s.color, marginBottom: 5 }}>
            {title}
          </div>
        )}
        <div style={{ color: 'var(--text-1)', lineHeight: 1.55 }}>{children}</div>
        {action && <div style={{ marginTop: 'var(--space-3)' }}>{action}</div>}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-3)',
            cursor: 'pointer',
            fontSize: '16px',
            lineHeight: 1,
            padding: '2px 0 0',
          }}
        >
          ×
        </button>
      )}
    </div>
  );
};

export default Alert;
