/**
 * An unlit berth waiting for its code. Loading on this panel is not a
 * shimmer sweeping across a card — it is a recessed slot with nothing in
 * it yet, breathing faintly.
 */

export const Skeleton = ({ className = '', style: outerStyle, ...props }) => (
  <div
    className={`berth-wait ${className}`}
    aria-hidden="true"
    style={{
      background: 'var(--panel-0)',
      border: '1px solid var(--rule-1)',
      borderRadius: '1px',
      boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.5)',
      ...outerStyle,
    }}
    {...props}
  />
);

export default Skeleton;
