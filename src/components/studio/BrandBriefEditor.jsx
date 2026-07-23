"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Save, Check } from "lucide-react";
import { Card } from "@/components/perceev/Card";
import { Badge } from "@/components/perceev/Badge";
import { Button } from "@/components/perceev/Button";
import { Input } from "@/components/perceev/Input";

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

function ListField({ label, hint, value, onChange, rows = 3, testId }) {
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      <textarea
        data-testid={testId}
        value={(value || []).join("\n")}
        onChange={(e) => onChange(e.target.value.split("\n"))}
        onBlur={(e) => onChange(e.target.value.split("\n").map((s) => s.trim()).filter(Boolean))}
        rows={rows}
        style={areaStyle}
        placeholder={hint}
      />
      {hint && <div style={{ fontSize: "11px", color: "var(--text-3)", marginTop: "4px" }}>{hint}</div>}
    </div>
  );
}

/**
 * Brand Brief editor — the block-structured form (locked decision #8):
 * one-liner, vertical/personas, priority topics, money pages, competitors,
 * tone rules, platforms, win definition. Seeded from healthcare-cxo on
 * first use.
 */
export function BrandBriefEditor({ brand }) {
  const [brief, setBrief] = useState(null);
  const [seeded, setSeeded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/brand-briefs?brand=${encodeURIComponent(brand || "")}`, { cache: "no-store" });
      if (!res.ok) throw new Error((await res.json()).detail || "Failed to load brief");
      const data = await res.json();
      setBrief(data.brief);
      setSeeded(data.seeded);
    } catch (e) {
      setError(e.message);
    }
  }, [brand]);

  useEffect(() => {
    load();
  }, [load]);

  const set = (key, value) => {
    setBrief((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/brand-briefs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand, brief }),
      });
      if (!res.ok) throw new Error((await res.json()).detail || "Save failed");
      setSeeded(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (!brief) {
    return (
      <div style={{ padding: "var(--space-7)", textAlign: "center" }}>
        {error ? (
          <span style={{ fontSize: "12px", color: "var(--crit)" }}>{error}</span>
        ) : (
          <Loader2 size={18} style={{ color: "var(--text-3)", animation: "spin 1s linear infinite" }} />
        )}
      </div>
    );
  }

  return (
    <Card style={{ padding: "var(--space-7)" }} data-testid="studio-brief-editor">
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginBottom: "var(--space-6)" }}>
        <h3 style={{ fontFamily: "var(--font-sans)", fontSize: "17px", fontWeight: 600, color: "var(--text-1)" }}>
          Brand brief — {brand}
        </h3>
        {seeded && <Badge variant="moderate">seeded from healthcare-cxo — save to persist</Badge>}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
        <div>
          <label style={labelStyle}>One-liner (what they sell)</label>
          <textarea
            data-testid="brief-one-liner"
            value={brief.one_liner || ""}
            onChange={(e) => set("one_liner", e.target.value)}
            rows={2}
            style={areaStyle}
          />
        </div>

        <Input
          id="brief-vertical"
          data-testid="brief-vertical"
          label="Vertical"
          value={brief.vertical || ""}
          onChange={(e) => set("vertical", e.target.value)}
          placeholder="healthcare"
        />

        <ListField
          label="Target personas (one per line)"
          value={brief.personas}
          onChange={(v) => set("personas", v)}
          testId="brief-personas"
        />

        <ListField
          label="Priority topics (3–6, one per line)"
          value={brief.priority_topics}
          onChange={(v) => set("priority_topics", v)}
          rows={4}
          testId="brief-topics"
        />

        <ListField
          label="Money pages (URLs, one per line)"
          hint="Pages that make money — content should funnel authority toward these."
          value={brief.money_pages}
          onChange={(v) => set("money_pages", v)}
          rows={2}
          testId="brief-money-pages"
        />

        <ListField
          label="Competitor set (one per line)"
          value={brief.competitors}
          onChange={(v) => set("competitors", v)}
          rows={2}
          testId="brief-competitors"
        />

        <ListField
          label="Tone & format rules (one per line)"
          hint='e.g. "tables not listicles", "always cite a stat"'
          value={brief.tone_rules}
          onChange={(v) => set("tone_rules", v)}
          rows={4}
          testId="brief-tone-rules"
        />

        <ListField
          label="Platforms that matter (one per line)"
          value={brief.platforms}
          onChange={(v) => set("platforms", v)}
          rows={2}
          testId="brief-platforms"
        />

        <div>
          <label style={labelStyle}>Definition of a win</label>
          <textarea
            data-testid="brief-win"
            value={brief.win_definition || ""}
            onChange={(e) => set("win_definition", e.target.value)}
            rows={2}
            style={areaStyle}
            placeholder="cited URL vs mention vs approval"
          />
        </div>

        {error && <div style={{ fontSize: "12px", color: "var(--crit)" }}>{error}</div>}

        <div>
          <Button data-testid="brief-save" variant="primary" size="md" onClick={save} disabled={saving}>
            {saving ? (
              <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
            ) : saved ? (
              <Check size={14} />
            ) : (
              <Save size={14} />
            )}
            {saved ? "Saved" : "Save brief"}
          </Button>
        </div>
      </div>
    </Card>
  );
}
