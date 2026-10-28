"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, Trash2, Link2, FileText, Ban, BookA, GripVertical } from "lucide-react";
import { Card } from "@/components/perceev/Card";
import { Badge } from "@/components/perceev/Badge";
import { Button } from "@/components/perceev/Button";
import { Input } from "@/components/perceev/Input";
import { Select } from "@/components/perceev/Select";

const TYPE_META = {
  url: { label: "Pinned source", icon: Link2, blurb: "A page agents should prefer citing. Content is fetched and stored." },
  snippet: { label: "Ground truth", icon: FileText, blurb: "Facts that outrank model knowledge — pricing, capabilities, positioning." },
  banned_claims: { label: "Banned claims", icon: Ban, blurb: "Things no agent may ever state. The Editor enforces these hard." },
  glossary: { label: "Glossary", icon: BookA, blurb: "Terminology agents must use exactly." },
};



/**
 * Knowledge blocks — the stackable context layer. Every agent inherits the
 * active blocks; drag order = precedence on conflict.
 */
export function KnowledgePanel({ brand }) {
  const [blocks, setBlocks] = useState(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ type: "snippet", title: "", content: "", source_url: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [dragIdx, setDragIdx] = useState(null);
  const [overIdx, setOverIdx] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/knowledge?brand=${encodeURIComponent(brand || "")}`, { cache: "no-store" });
      if (!res.ok) throw new Error((await res.json()).detail || "Failed to load knowledge");
      setBlocks((await res.json()).blocks || []);
    } catch (e) {
      setError(e.message);
      setBlocks([]);
    }
  }, [brand]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const add = async () => {
    if (form.type === "url" ? !form.source_url.trim() : !form.content.trim()) {
      setError(form.type === "url" ? "Enter the URL to pin." : "Content is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand, ...form }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Failed to add block");
      setForm({ type: "snippet", title: "", content: "", source_url: "" });
      setAdding(false);
      refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (block) => {
    setBlocks((prev) => prev.map((b) => (b.id === block.id ? { ...b, active: !b.active } : b)));
    await fetch(`/api/knowledge/${block.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !block.active }),
    }).catch(() => refresh());
  };

  const remove = async (block) => {
    setBlocks((prev) => prev.filter((b) => b.id !== block.id));
    await fetch(`/api/knowledge/${block.id}`, { method: "DELETE" }).catch(() => refresh());
  };

  const dropReorder = async () => {
    if (dragIdx == null || overIdx == null || dragIdx === overIdx) {
      setDragIdx(null);
      setOverIdx(null);
      return;
    }
    const next = [...blocks];
    const [moved] = next.splice(dragIdx, 1);
    next.splice(overIdx > dragIdx ? overIdx - 1 : overIdx, 0, moved);
    setBlocks(next);
    setDragIdx(null);
    setOverIdx(null);
    await fetch("/api/knowledge", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brand, order: next.map((b) => b.id) }),
    }).catch(() => refresh());
  };

  if (blocks === null) {
    return (
      <div style={{ padding: "var(--space-7)", textAlign: "center" }}>
        <Loader2 size={18} style={{ color: "var(--text-3)", animation: "spin 1s linear infinite" }} />
      </div>
    );
  }

  return (
    <div data-testid="knowledge-panel" style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: "13px", color: "var(--text-2)" }}>
          Every agent inherits the active blocks below. Drag to set precedence — higher wins on conflict.
        </span>
        <Button variant="primary" size="sm" onClick={() => setAdding((v) => !v)} data-testid="knowledge-add">
          <Plus size={14} /> Add block
        </Button>
      </div>

      {error && <div style={{ fontSize: "12px", color: "var(--crit)" }}>{error}</div>}

      {adding && (
        <Card variant="flush" style={{ padding: "var(--space-5)", display: "flex", flexDirection: "column", gap: "var(--space-4)" }} data-testid="knowledge-form">
          <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap" }}>
            <div style={{ minWidth: "200px", flex: 1 }}>
              <Select label="Type" value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))} data-testid="knowledge-type">
                {Object.entries(TYPE_META).map(([key, m]) => (
                  <option key={key} value={key}>{m.label}</option>
                ))}
              </Select>
              <div style={{ fontSize: "11px", color: "var(--text-3)", marginTop: "4px" }}>{TYPE_META[form.type].blurb}</div>
            </div>
            <Input
              label="Title"
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              placeholder={form.type === "url" ? "(auto from URL if blank)" : "e.g. Corporate pricing 2026"}
              style={{ flex: 1, minWidth: "200px" }}
              data-testid="knowledge-title"
            />
          </div>

          {form.type === "url" ? (
            <Input
              label="URL to pin (content is fetched and stored)"
              value={form.source_url}
              onChange={(e) => setForm((f) => ({ ...f, source_url: e.target.value }))}
              placeholder="https://yourbrand.in/pricing"
              data-testid="knowledge-url"
            />
          ) : (
            <div>
              <label className="lbl" htmlFor="knowledge-content">
                Content
              </label>
              <textarea
                id="knowledge-content"
                data-testid="knowledge-content"
                value={form.content}
                onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
                rows={4}
                className="inp"
                placeholder={
                  form.type === "banned_claims"
                    ? "One rule per line: Never claim NABL accreditation for the Pune lab."
                    : form.type === "glossary"
                      ? "One term per line: 'home collection' (never 'home visit')"
                      : "Corporate packages start at ₹1,499 per employee for 45 tests…"
                }
              />
            </div>
          )}

          <div>
            <Button variant="primary" size="sm" onClick={add} disabled={busy} data-testid="knowledge-save">
              {busy ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> : <Plus size={13} />}
              {form.type === "url" ? "Fetch & add" : "Add"}
            </Button>
          </div>
        </Card>
      )}

      {blocks.length === 0 && !adding && (
        <Card variant="flush" style={{ padding: "var(--space-8)", textAlign: "center" }}>
          <p style={{ fontSize: "13px", color: "var(--text-3)", lineHeight: 1.6 }}>
            No knowledge blocks yet. Pin your pricing page, paste ground-truth facts, and list banned
            claims — every agent will ground its drafts in them.
          </p>
        </Card>
      )}

      <div
        style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={dropReorder}
      >
        {blocks.map((b, i) => {
          const meta = TYPE_META[b.type] || TYPE_META.snippet;
          const Icon = meta.icon;
          return (
            <div
              key={b.id}
              data-testid="knowledge-block"
              draggable
              onDragStart={() => setDragIdx(i)}
              onDragEnter={() => setOverIdx(i)}
              onDragEnd={() => {
                setDragIdx(null);
                setOverIdx(null);
              }}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "var(--space-3)",
                background: dragIdx === i ? "var(--bg-3)" : "var(--bg-1)",
                border: `1px solid ${overIdx === i && dragIdx != null && dragIdx !== i ? "var(--accent-border)" : "var(--border-1)"}`,
                borderRadius: "var(--radius-2)",
                padding: "var(--space-4)",
                opacity: b.active ? 1 : 0.55,
                cursor: "grab",
              }}
            >
              <GripVertical size={14} style={{ color: "var(--text-3)", marginTop: "2px", flexShrink: 0 }} />
              <Icon size={15} style={{ color: "var(--brand)", marginTop: "2px", flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" }}>
                  <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-1)" }}>{b.title}</span>
                  <Badge variant={b.type === "banned_claims" ? "weak" : "neutral"}>{meta.label}</Badge>
                </div>
                <div style={{ fontSize: "12px", color: "var(--text-2)", marginTop: "4px", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", lineHeight: 1.5 }}>
                  {b.content}
                </div>
                {b.source_url && (
                  <a href={b.source_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: "11px", color: "var(--info)", marginTop: "4px", display: "inline-block" }}>
                    {b.source_url}
                  </a>
                )}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexShrink: 0 }}>
                <button
                  onClick={() => toggle(b)}
                  title={b.active ? "Deactivate" : "Activate"}
                  data-testid="knowledge-toggle"
                  style={{
                    width: "34px",
                    height: "18px",
                    borderRadius: "9px",
                    border: "1px solid var(--border-2)",
                    background: b.active ? "var(--brand)" : "var(--bg-2)",
                    position: "relative",
                    cursor: "pointer",
                  }}
                >
                  <span
                    style={{
                      position: "absolute",
                      top: "2px",
                      left: b.active ? "17px" : "2px",
                      width: "12px",
                      height: "12px",
                      borderRadius: "50%",
                      background: b.active ? "var(--accent-fg)" : "var(--text-3)",
                      transition: "left var(--dur-fast)",
                    }}
                  />
                </button>
                <button
                  onClick={() => remove(b)}
                  title="Delete"
                  style={{ background: "none", border: "none", color: "var(--text-3)", cursor: "pointer", padding: "2px", display: "flex" }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
