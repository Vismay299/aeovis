import { formatDelta } from "./chartMath";

const TONE = {
  pos: { color: "var(--good)", bg: "var(--good-bg)", border: "var(--good-border)" },
  neg: { color: "var(--rival)", bg: "var(--rival-soft)", border: "var(--rival-border)" },
  zero: { color: "var(--text-3)", bg: "var(--bg-2)", border: "var(--border-1)" },
  null: { color: "var(--text-3)", bg: "transparent", border: "var(--border-1)" },
};

/** CSS-drawn triangle — crisp at any size, no icon font/glyph fallback risk. */
const Triangle = ({ direction, color }) => {
  if (!direction) return null;
  const base =
    direction === "up"
      ? { borderBottom: `5px solid ${color}`, borderTop: "none" }
      : { borderTop: `5px solid ${color}`, borderBottom: "none" };
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-block",
        width: 0,
        height: 0,
        borderLeft: "4px solid transparent",
        borderRight: "4px solid transparent",
        ...base,
      }}
    />
  );
};

/**
 * Value-delta pill. Positive -> `--good` with an up triangle, negative ->
 * `--rival` with a down triangle, zero/null -> muted with no triangle.
 * Reused by RankTable (per-row delta) and TrendChart's hover tooltip
 * (point-over-previous-point delta).
 */
export const DeltaChip = ({ value, decimals = 1, className = "", testId }) => {
  const { text, sign } = formatDelta(value, decimals);
  const tone = TONE[sign] || TONE.null;
  const direction = sign === "pos" ? "up" : sign === "neg" ? "down" : null;

  return (
    <span
      data-testid={testId}
      className={`inline-flex items-center select-none ${className}`}
      style={{
        gap: "5px",
        padding: sign === "null" ? "2px 0" : "2px 7px",
        background: tone.bg,
        border: sign === "null" ? "none" : `1px solid ${tone.border}`,
        borderRadius: "var(--radius-1)",
        color: tone.color,
        fontFamily: "var(--font-sans)",
        fontSize: "12px",
        fontWeight: 600,
        fontVariantNumeric: "tabular-nums",
        lineHeight: "16px",
        whiteSpace: "nowrap",
      }}
    >
      <Triangle direction={direction} color={tone.color} />
      {text}
    </span>
  );
};
