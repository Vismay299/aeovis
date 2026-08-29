/**
 * Broadcast strap — the condensed-caps segment marker DESIGN.md calls for
 * ("Section kickers are broadcast straps: condensed caps on a gold-keyline
 * strap. Not an eyebrow grammar — straps mark segments, like a rundown.").
 * Mirrors the `Strap` from the deleted /chart-preview design harness so the new
 * Overview analytics blocks read as the same "Results Night" rundown as the
 * chart-library design harness.
 */
export const SectionStrap = ({ children, testId }) => (
  <div
    data-testid={testId}
    style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginBottom: "var(--space-4)" }}
  >
    <span style={{ width: "3px", height: "14px", background: "var(--accent)", flexShrink: 0 }} />
    <span
      style={{
        fontFamily: "var(--font-display)",
        fontWeight: 700,
        fontSize: "13px",
        textTransform: "uppercase",
        letterSpacing: "0.12em",
        color: "var(--text-1)",
      }}
    >
      {children}
    </span>
  </div>
);
