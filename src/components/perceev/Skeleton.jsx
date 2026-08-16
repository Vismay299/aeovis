/** A loading placeholder: a calm opacity pulse, never a sweeping shimmer. */

export const Skeleton = ({ className = '', style: outerStyle, ...props }) => (
  <div
    className={`skel ${className}`.trim()}
    aria-hidden="true"
    style={outerStyle}
    {...props}
  />
);

export default Skeleton;
