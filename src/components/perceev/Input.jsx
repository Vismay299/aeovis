"use client";

import { useId } from "react";

/** A labelled text field, with its error or hint underneath. */

export const Input = ({
  label,
  error,
  hint,
  id: providedId,
  size = 'md',
  className = '',
  style: outerStyle,
  ...props
}) => {
  const generatedId = useId();
  const id = providedId || generatedId;
  return (
    <div className={className} style={outerStyle}>
      {label && (
        <label htmlFor={id} className="lbl">{label}</label>
      )}
      <input
        id={id}
        className={`inp${size === 'sm' ? ' inp--sm' : ''}`}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={error && id ? `${id}-err` : undefined}
        {...props}
      />
      {error ? (
        <p
          id={id ? `${id}-err` : undefined}
          style={{ marginTop: 6, fontSize: 13, color: 'var(--crit)' }}
        >
          {error}
        </p>
      ) : (
        hint && (
          <p style={{ marginTop: 6, fontSize: 13, color: 'var(--ink-3)' }}>{hint}</p>
        )
      )}
    </div>
  );
};

export default Input;
