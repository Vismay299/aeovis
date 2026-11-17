"use client";

import { useState } from "react";
import { Lock, X, Plus, ArrowRight } from "lucide-react";
import { validatePipeline } from "@/shared/content/agents/blocks";

const mono = {
  fontFamily: "var(--font-mono)",
  fontSize: "10px",
  fontWeight: 500,
  textTransform: "uppercase",
  letterSpacing: "0.12em",
  color: "var(--text-2)",
};

/**
 * Crew Canvas — the drag-and-drop pipeline editor. The lane is the agent's
 * crew in run order; the palette below holds addable specialist blocks.
 * Strategist opens, Writer drafts, Editor closes — locked posts. Everything
 * between is composable. Drops that would break the pipeline contract are
 * rejected with the exact rule named.
 */
export function CrewCanvas({ blocks, pipeline, blockConfig, onChange, onConfigChange }) {
  const [dragIdx, setDragIdx] = useState(null);
  const [overIdx, setOverIdx] = useState(null);
  const [error, setError] = useState(null);

  const registry = Object.fromEntries((blocks || []).map((b) => [b.slug, b]));
  const lane = pipeline || [];

  const apply = (next) => {
    const v = validatePipeline(next);
    if (!v.ok) {
      setError(v.errors[0]);
      setTimeout(() => setError(null), 3200);
      return false;
    }
    setError(null);
    onChange(v.value);
    return true;
  };

  const moveTo = (from, to) => {
    if (from === to || from == null) return;
    const next = [...lane];
    const [moved] = next.splice(from, 1);
    next.splice(to > from ? to - 1 : to, 0, moved);
    apply(next);
  };

  const removeAt = (idx) => {
    const next = lane.filter((_, i) => i !== idx);
    apply(next);
  };

  const addBlock = (slug) => {
    const b = registry[slug];
    if (!b) return;
    const next = [...lane];
    if (b.kind === "context") {
      next.splice(lane.indexOf("draft"), 0, slug); // before the Writer
    } else {
      next.splice(lane.length - 1, 0, slug); // before the Editor
    }
    apply(next);
  };

  const inLane = new Set(lane);
  const palette = (blocks || []).filter((b) => !inLane.has(b.slug) && !b.locked);

  return (
    <div data-testid="crew-canvas">
      <label style={{ ...mono, display: "block", marginBottom: "var(--space-2)" }}>
        The crew (drag to reorder · run order left → right)
      </label>

      {/* The lane */}
      <div
        style={{
          display: "flex",
          alignItems: "stretch",
          gap: "4px",
          flexWrap: "wrap",
          background: "var(--bg-0)",
          border: "1px solid var(--border-1)",
          borderRadius: "var(--radius-2)",
          padding: "var(--space-3)",
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={() => {
          if (dragIdx != null && overIdx != null) moveTo(dragIdx, overIdx);
          setDragIdx(null);
          setOverIdx(null);
        }}
      >
        {lane.map((slug, i) => {
          const b = registry[slug] || { name: slug, emoji: "🤖", kind: "?" };
          const locked = b.locked;
          const schema = b.config_schema || null;
          const cfg = blockConfig?.[slug] || {};
          return (
            <div key={slug} style={{ display: "flex", alignItems: "center", gap: "4px" }}>
              <div
                data-testid={`crew-block-${slug}`}
                draggable={!locked}
                onDragStart={() => setDragIdx(i)}
                onDragEnter={() => setOverIdx(i)}
                onDragEnd={() => {
                  setDragIdx(null);
                  setOverIdx(null);
                }}
                title={b.blurb}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "4px",
                  padding: "8px 10px",
                  borderRadius: "4px",
                  border: `1px solid ${overIdx === i && dragIdx != null && dragIdx !== i ? "var(--accent-border)" : "var(--border-2)"}`,
                  background: dragIdx === i ? "var(--bg-3)" : "var(--bg-1)",
                  cursor: locked ? "default" : "grab",
                  opacity: dragIdx === i ? 0.6 : 1,
                  minWidth: "108px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <span style={{ fontSize: "15px" }}>{b.emoji}</span>
                  <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-1)", flex: 1 }}>{b.name}</span>
                  {locked ? (
                    <Lock size={10} style={{ color: "var(--text-3)" }} />
                  ) : (
                    <button
                      onClick={() => removeAt(i)}
                      title="Remove"
                      style={{ background: "none", border: "none", color: "var(--text-3)", cursor: "pointer", padding: 0, display: "flex" }}
                    >
                      <X size={11} />
                    </button>
                  )}
                </div>
                <span style={{ fontSize: "8px", textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-3)" }}>
                  {b.kind}
                </span>
                {schema &&
                  Object.entries(schema).map(([key, spec]) => (
                    <input
                      key={key}
                      data-testid={`crew-config-${slug}-${key}`}
                      value={cfg[key] ?? spec.default ?? ""}
                      onChange={(e) =>
                        onConfigChange({
                          ...blockConfig,
                          [slug]: { ...cfg, [key]: spec.type === "number" ? Number(e.target.value) : e.target.value },
                        })
                      }
                      placeholder={spec.label}
                      title={spec.label}
                      className="inp inp--sm"
                      aria-label={spec.label}
                      style={{ width: "120px" }}
                    />
                  ))}
              </div>
              {i < lane.length - 1 && <ArrowRight size={11} style={{ color: "var(--text-3)", flexShrink: 0 }} />}
            </div>
          );
        })}
      </div>

      {error && (
        <div data-testid="crew-canvas-error" style={{ fontSize: "11px", color: "var(--crit)", marginTop: "var(--space-2)" }}>
          {error}
        </div>
      )}

      {/* The palette */}
      {palette.length > 0 && (
        <div style={{ marginTop: "var(--space-3)" }}>
          <span style={{ ...mono, fontSize: "9px" }}>Add a specialist</span>
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "6px" }}>
            {palette.map((b) => (
              <button
                key={b.slug}
                data-testid={`crew-add-${b.slug}`}
                onClick={() => addBlock(b.slug)}
                title={b.blurb}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "5px 10px",
                  borderRadius: "var(--radius-round)",
                  border: "1px dashed var(--border-3)",
                  background: "transparent",
                  color: "var(--text-2)",
                  fontSize: "11px",
                  cursor: "pointer",
                }}
              >
                <Plus size={10} />
                {b.emoji} {b.name}
                <span style={{ fontSize: "8px", textTransform: "uppercase", color: "var(--text-3)" }}>{b.kind}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
