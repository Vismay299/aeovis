/**
 * A panel: an engraved rectangle of painted steel bolted to the wall.
 * `raised` adds the nickel bevel for a panel that stands off the face.
 * `keyline` runs a 2px lamp strip along the top edge to mark which role
 * owns the region — top edge only, never a thick side border.
 */

export const Card = ({
  variant = 'padded',
  raised = false,
  keyline = null,
  className = '',
  children,
  style: outerStyle,
  ...props
}) => {
  const padded = variant !== 'flush';

  return (
    <div
      className={`sb-panel ${raised ? 'sb-panel--raised' : ''} ${className}`}
      {...props}
      style={{
        padding: padded ? 'var(--space-5)' : 0,
        borderTop: keyline ? `2px solid var(--lamp-${keyline})` : undefined,
        ...outerStyle,
      }}
    >
      {children}
    </div>
  );
};

export default Card;
