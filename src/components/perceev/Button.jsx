/**
 * Illuminated pushbutton.
 *
 * Every action on this surface is a button on a signal panel: an engraved
 * legend on a collared face that physically depresses when pressed. The
 * primary action is a lamp already showing a cleared path, so it is never
 * hidden; hover is the filament inrush. States live in signal.css.
 *
 * variant: primary | secondary | ghost | danger | route
 */

export const Button = ({
  variant = 'primary',
  size = 'md',
  lamp = false,
  disabled,
  className = '',
  children,
  ...props
}) => (
  <button
    className={`sb-btn sb-btn--${variant} sb-btn--${size} ${className}`}
    disabled={disabled}
    {...props}
  >
    {lamp && <span className="sb-btn__lamp" aria-hidden="true" />}
    {children}
  </button>
);

export default Button;
