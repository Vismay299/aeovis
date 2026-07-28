/**
 * The wordmark. Lowercase "perceev" is a binding brand commitment, so the
 * signage voice carries it in lowercase: Archivo at the expanded width,
 * the way a station nameboard is set. The terminal v is flat proceed green
 * — the aspect the brand shows. Signage lettering is paint, not glow.
 */

export const Wordmark = ({ size = 'default', className = '' }) => {
  const fontSize = { default: '25px', sm: '20px', lg: '32px' }[size] || '25px';

  return (
    <span
      className={`inline-flex items-baseline select-none ${className}`}
      style={{
        fontFamily: 'var(--font-sans)',
        fontStretch: 'var(--wdth-sig)',
        fontWeight: 800,
        fontSize,
        letterSpacing: '-0.005em',
        lineHeight: 1,
        color: 'var(--text-1)',
      }}
    >
      percee<span style={{ color: 'var(--lamp-green)' }}>v</span>
    </span>
  );
};

export default Wordmark;
