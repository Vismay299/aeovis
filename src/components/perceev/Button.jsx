/**
 * Button adapter for the shared light product primitives.
 *
 * The variant names are the ones this codebase already calls with; they map
 * onto the design system's `.btn--*` modifiers. See docs/design/DESIGN-SYSTEM.md.
 */

const VARIANT = {
  primary: 'btn--primary',
  secondary: 'btn--ghost',
  ghost: 'btn--quiet',
  quiet: 'btn--quiet',
  danger: 'btn--danger',
  route: 'btn--primary',
  onbrand: 'btn--onbrand',
};

const SIZE = { sm: 'btn--sm', md: '', lg: 'btn--lg' };

export const Button = ({
  variant = 'primary',
  size = 'md',
  lamp,          /* accepted and ignored: the rejected world's lamp dot */
  disabled,
  className = '',
  children,
  ...props
}) => (
  <button
    type={props.type || 'button'}
    className={`btn ${VARIANT[variant] || VARIANT.primary} ${SIZE[size] ?? ''} ${className}`.trim()}
    disabled={disabled}
    {...props}
  >
    {children}
  </button>
);

export default Button;
