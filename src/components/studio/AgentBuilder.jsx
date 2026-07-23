"use client";

import { useState } from "react";
import { Loader2, Save, Trash2, ArrowLeft, Check } from "lucide-react";
import { Card } from "@/components/perceev/Card";
import { Badge } from "@/components/perceev/Badge";
import { Button } from "@/components/perceev/Button";
import { Input } from "@/components/perceev/Input";
import { Select } from "@/components/perceev/Select";
import { CrewCanvas } from "./CrewCanvas";

const labelStyle = {
  display: "block",
  fontFamily: "var(--font-mono)",
  fontSize: "10px",
  fontWeight: 500,
  textTransform: "uppercase",
  letterSpacing: "0.12em",
  color: "var(--text-2)",
  marginBottom: "var(--space-2)",
};

const areaStyle = {
  width: "100%",
  background: "var(--bg-1)",
  border: "1px solid var(--border-2)",
  borderRadius: "var(--radius-1)",
  padding: "10px 14px",
  fontFamily: "var(--font-sans)",
  fontSize: "13px",
  color: "var(--text-1)",
  outline: "none",
  resize: "vertical",
  boxSizing: "border-box",
  lineHeight: 1.5,
};

const CHANNELS = ["website", "blog", "linkedin", "x", "newsletter", "other"];

// Review dimensions the operator can emphasize, per base pipeline.
const EMPHASIS_DIMS = {
  geo_article: [
    ["citation_validity", "Citation validity"],
    ["authority_specificity", "Authority / specificity"],
    ["facts_vs_research", "Factual grounding"],
    ["channel_checklist", "Format structure"],
  ],
  linkedin_post: [
    ["hook_strength", "Hook strength"],
    ["persona_fit", "Persona fit"],
    ["facts_vs_research", "Factual grounding"],
    ["format_checklist", "Format structure"],
  ],
};

/**
 * Agent builder — create or edit a custom content agent. Every knob the plan
 * asks for: what (format), where (channel), how (length, design rules, custom
 * instructions, format config), and focus (rubric emphasis).
 */
export function AgentBuilder({ brand, formats, blocks, defaultPipelines, agent, onSaved, onCancel, onDeleted }) {
  const [form, setForm] = useState(() => ({
    name: agent?.name || "",
    emoji: agent?.emoji || "🤖",
    description: agent?.description || "",
    format: agent?.format || "article",
    channel: agent?.channel || "website",
    length_hint: agent?.length_hint || "",
    format_config: agent?.format_config || {},
    design_rules: agent?.design_rules || [],
    custom_instructions: agent?.custom_instructions || "",
    rubric_emphasis: agent?.rubric_emphasis || {},
    pipeline: agent?.pipeline || null,
    block_config: agent?.block_config || {},
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const isEdit = !!agent?.id;
  const isBuiltin = agent?.is_builtin === true;
  const selectedFormat = (formats || []).find((f) => f.key === form.format) || {};
  const base = selectedFormat.base || "geo_article";
  const emphasisDims = EMPHASIS_DIMS[base] || EMPHASIS_DIMS.geo_article;

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const pickFormat = (fmt) => {
    setForm((f) => ({
      ...f,
      format: fmt.key,
      emoji: !isEdit && (f.emoji === "🤖" || !f.emoji) ? fmt.emoji : f.emoji,
      length_hint: f.length_hint || fmt.length_hint || "",
      // Reset format config to the new format's defaults.
      format_config: fmt.config_schema
        ? Object.fromEntries(Object.entries(fmt.config_schema).map(([k, s]) => [k, s.default]))
        : {},
      channel: f.channel || (fmt.base === "linkedin_post" ? "linkedin" : "website"),
    }));
  };

  const save = async () => {
    if (!form.name.trim()) {
      setError("Give your agent a name.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const url = isEdit ? `/api/agents/${agent.id}` : "/api/agents";
      const res = await fetch(url, {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand, ...form }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Save failed");
      onSaved?.(data.agent);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const del = async () => {
    if (!isEdit) return;
    setSaving(true);
    try {
      await fetch(`/api/agents/${agent.id}`, { method: "DELETE" });
      onDeleted?.(agent.id);
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  };

  return (
    <div style={{ maxWidth: "760px" }} data-testid="agent-builder">
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginBottom: "var(--space-5)" }}>
        <Button variant="secondary" size="sm" onClick={onCancel}>
          <ArrowLeft size={14} /> Agents
        </Button>
        <h3 style={{ fontFamily: "var(--font-sans)", fontSize: "17px", fontWeight: 600, color: "var(--text-1)" }}>
          {isEdit ? `Edit ${agent.name}` : "New agent"}
        </h3>
        {isBuiltin && <Badge variant="muted">built-in</Badge>}
      </div>

      <Card style={{ padding: "var(--space-6)", display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
        {/* Identity */}
        <div style={{ display: "flex", gap: "var(--space-4)", alignItems: "flex-end" }}>
          <div style={{ width: "72px" }}>
            <label style={labelStyle}>Icon</label>
            <input
              data-testid="agent-emoji"
              value={form.emoji}
              onChange={(e) => set("emoji", e.target.value.slice(0, 4))}
              style={{ ...areaStyle, textAlign: "center", fontSize: "24px", padding: "6px" }}
            />
          </div>
          <Input
            label="Agent name"
            data-testid="agent-name"
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="e.g. Listicle Writer"
            style={{ flex: 1 }}
          />
        </div>

        <div>
          <label style={labelStyle}>What it does (one line)</label>
          <textarea
            data-testid="agent-description"
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
            rows={2}
            style={areaStyle}
            placeholder="Ranked, scannable lists optimized to get lifted item-by-item by AI engines."
          />
        </div>

        {/* Format picker — the "what" */}
        <div>
          <label style={labelStyle}>Output format (what to build)</label>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: "var(--space-2)" }}>
            {(formats || []).map((f) => {
              const active = form.format === f.key;
              return (
                <button
                  key={f.key}
                  data-testid={`agent-format-${f.key}`}
                  onClick={() => pickFormat(f)}
                  title={f.blurb}
                  style={{
                    textAlign: "left",
                    padding: "var(--space-3)",
                    borderRadius: "var(--radius-1)",
                    border: `1px solid ${active ? "var(--accent-border)" : "var(--border-1)"}`,
                    background: active ? "var(--accent-soft)" : "var(--bg-1)",
                    cursor: "pointer",
                    transition: "all var(--dur-fast)",
                  }}
                >
                  <div style={{ fontSize: "18px" }}>{f.emoji}</div>
                  <div style={{ fontSize: "12px", fontWeight: 600, color: active ? "var(--accent-text)" : "var(--text-1)", marginTop: "2px" }}>
                    {f.label}
                  </div>
                  <div style={{ fontSize: "10px", color: "var(--text-3)", marginTop: "2px", lineHeight: 1.35 }}>{f.blurb}</div>
                </button>
              );
            })}
          </div>
          <div style={{ fontSize: "11px", color: "var(--text-3)", marginTop: "var(--space-2)" }}>
            Runs on the <strong>{base === "linkedin_post" ? "social" : "GEO citation"}</strong> pipeline.
          </div>
        </div>

        {/* Format-specific config */}
        {selectedFormat.config_schema && (
          <div style={{ display: "flex", gap: "var(--space-4)", flexWrap: "wrap" }}>
            {Object.entries(selectedFormat.config_schema).map(([key, schema]) => (
              <div key={key} style={{ minWidth: "140px" }}>
                <label style={labelStyle}>{schema.label}</label>
                {schema.type === "bool" ? (
                  <Select
                    value={String(form.format_config[key] ?? schema.default)}
                    onChange={(e) => set("format_config", { ...form.format_config, [key]: e.target.value === "true" })}
                  >
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </Select>
                ) : (
                  <Input
                    type="number"
                    value={form.format_config[key] ?? schema.default}
                    onChange={(e) => set("format_config", { ...form.format_config, [key]: Number(e.target.value) })}
                  />
                )}
              </div>
            ))}
          </div>
        )}

        {/* The crew — composable pipeline */}
        <CrewCanvas
          blocks={blocks}
          pipeline={form.pipeline || defaultPipelines?.[base] || ["coordinate", "research", "benchmark", "draft", "review"]}
          blockConfig={form.block_config}
          onChange={(pipeline) => set("pipeline", pipeline)}
          onConfigChange={(cfg) => set("block_config", cfg)}
        />

        {/* Where + length */}
        <div style={{ display: "flex", gap: "var(--space-4)", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: "180px" }}>
            <Select label="Channel (where it goes)" value={form.channel} onChange={(e) => set("channel", e.target.value)} data-testid="agent-channel">
              {CHANNELS.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </Select>
          </div>
          <Input label="Target length" value={form.length_hint} onChange={(e) => set("length_hint", e.target.value)} placeholder="e.g. 900 words" style={{ flex: 1, minWidth: "180px" }} />
        </div>

        {/* How — design rules + custom instructions */}
        <div>
          <label style={labelStyle}>Design rules (one per line — added to the brand brief's tone rules)</label>
          <textarea
            data-testid="agent-design-rules"
            value={(form.design_rules || []).join("\n")}
            onChange={(e) => set("design_rules", e.target.value.split("\n"))}
            onBlur={(e) => set("design_rules", e.target.value.split("\n").map((s) => s.trim()).filter(Boolean))}
            rows={3}
            style={areaStyle}
            placeholder={"Bold each item name\nNo fluff intros\nOne sentence per idea"}
          />
        </div>

        <div>
          <label style={labelStyle}>Custom instructions (freeform — overrides defaults on conflict)</label>
          <textarea
            data-testid="agent-custom-instructions"
            value={form.custom_instructions}
            onChange={(e) => set("custom_instructions", e.target.value)}
            rows={3}
            style={areaStyle}
            placeholder="Always end with a note that prices change quarterly. Never recommend a specific competitor by name."
          />
        </div>

        {/* Focus — rubric emphasis */}
        <div>
          <label style={labelStyle}>What the Editor should weight most</label>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
            {emphasisDims.map(([dim, dimLabel]) => {
              const val = form.rubric_emphasis[dim] ?? 1;
              return (
                <div key={dim} style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                  <span style={{ fontSize: "12px", color: "var(--text-2)", width: "160px", flexShrink: 0 }}>{dimLabel}</span>
                  <input
                    type="range"
                    min="0.5"
                    max="2"
                    step="0.1"
                    value={val}
                    onChange={(e) => set("rubric_emphasis", { ...form.rubric_emphasis, [dim]: Number(e.target.value) })}
                    style={{ flex: 1, accentColor: "var(--accent)" }}
                  />
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: val > 1 ? "var(--accent-text)" : "var(--text-3)", width: "32px", textAlign: "right" }}>
                    {val.toFixed(1)}×
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {error && <div style={{ fontSize: "12px", color: "var(--crit)" }}>{error}</div>}

        <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "center" }}>
          <Button variant="primary" size="md" onClick={save} disabled={saving} data-testid="agent-save">
            {saving ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Save size={14} />}
            {isEdit ? "Save changes" : "Create agent"}
          </Button>
          {isEdit && !isBuiltin && (
            <Button variant="danger" size="md" onClick={del} disabled={saving}>
              <Trash2 size={14} /> Delete
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}
