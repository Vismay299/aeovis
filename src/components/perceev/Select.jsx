import { ChevronDown } from "lucide-react";

export const Select = ({ label, id, children, className = "", style: outerStyle, ...props }) => {
  return (
    <div className={className} style={{ position: "relative", ...outerStyle }}>
      {label && (
        <label
          htmlFor={id}
          style={{
            display: "block",
            fontFamily: "var(--font-mono)",
            fontSize: "10px",
            fontWeight: 500,
            textTransform: "uppercase",
            letterSpacing: "0.12em",
            color: "var(--text-2)",
            marginBottom: "var(--space-2)",
          }}
        >
          {label}
        </label>
      )}
      <div style={{ position: "relative" }}>
        <select
          id={id}
          style={{
            width: "100%",
            appearance: "none",
            background: "var(--bg-1)",
            border: "1px solid var(--border-2)",
            borderRadius: "var(--radius-1)",
            padding: "12px 40px 12px 16px",
            fontFamily: "var(--font-sans)",
            fontSize: "14px",
            color: "var(--text-1)",
            outline: "none",
            cursor: "pointer",
            transition: "border-color var(--dur-fast)",
            boxSizing: "border-box",
          }}
          onFocus={(e) => {
            e.target.style.borderColor = "var(--accent)";
          }}
          onBlur={(e) => {
            e.target.style.borderColor = "var(--border-2)";
          }}
          {...props}
        >
          {children}
        </select>
        <ChevronDown
          size={16}
          style={{
            position: "absolute",
            right: "12px",
            top: "50%",
            transform: "translateY(-50%)",
            pointerEvents: "none",
            color: "var(--text-2)",
          }}
        />
      </div>
    </div>
  );
};
