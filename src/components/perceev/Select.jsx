"use client";

import { useId } from "react";

/** A labelled select, sharing the text field's shape. */

export const Select = ({
  label,
  id: providedId,
  size = 'md',
  hint,
  children,
  className = '',
  style: outerStyle,
  ...props
}) => {
  const generatedId = useId();
  const id = providedId || generatedId;
  return (
    <div className={className} style={outerStyle}>
      {label && <label htmlFor={id} className="lbl">{label}</label>}
      <select
        id={id}
        className={`inp${size === 'sm' ? ' inp--sm' : ''}`}
        {...props}
      >
        {children}
      </select>
      {hint && <p style={{ marginTop: 6, fontSize: 13, color: 'var(--ink-3)' }}>{hint}</p>}
    </div>
  );
};

export default Select;
