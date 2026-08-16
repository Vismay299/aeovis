/**
 * A surface. `flush` gives the bare panel so the caller can supply its own
 * `.panel__h` / `.panel__b`; the default pads the body for simple content.
 */

export const Card = ({
  variant = 'padded',
  raised = false,
  keyline = null,   /* accepted and ignored: the rejected world's lamp strip */
  className = '',
  children,
  style: outerStyle,
  ...props
}) => {
  const padded = variant !== 'flush';

  return (
    <div
      className={`panel ${className}`.trim()}
      {...props}
      style={{
        boxShadow: raised ? 'var(--shadow-2)' : undefined,
        ...outerStyle,
      }}
    >
      {padded ? <div className="panel__b">{children}</div> : children}
    </div>
  );
};

export default Card;
