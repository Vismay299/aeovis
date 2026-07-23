"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, Pencil, Play, Sparkles } from "lucide-react";
import { Card } from "@/components/perceev/Card";
import { Badge } from "@/components/perceev/Badge";
import { Button } from "@/components/perceev/Button";
import { AgentBuilder } from "./AgentBuilder";

function AgentCard({ agent, onEdit, onRun }) {
  return (
    <Card style={{ padding: "var(--space-5)" }} data-testid="agent-card">
      <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-3)" }}>
        <div
          style={{
            width: "40px",
            height: "40px",
            borderRadius: "var(--radius-2)",
            background: "var(--accent-soft)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "22px",
            flexShrink: 0,
          }}
        >
          {agent.emoji || "🤖"}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
            <span style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-1)" }}>{agent.name}</span>
            {agent.is_builtin && <Badge variant="muted">built-in</Badge>}
          </div>
          <div style={{ display: "flex", gap: "6px", marginTop: "6px", flexWrap: "wrap" }}>
            <Badge variant="neutral">{agent.format}</Badge>
            {agent.channel && <Badge variant="muted">→ {agent.channel}</Badge>}
            {agent.pipeline && <Badge variant="accent">custom crew · {agent.pipeline.length}</Badge>}
          </div>
          {agent.description && (
            <p style={{ fontSize: "12px", color: "var(--text-2)", marginTop: "var(--space-2)", lineHeight: 1.5 }}>{agent.description}</p>
          )}
        </div>
      </div>
      <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-4)" }}>
        <Button variant="primary" size="sm" onClick={() => onRun(agent)} data-testid="agent-run">
          <Play size={13} /> Run
        </Button>
        <Button variant="secondary" size="sm" onClick={() => onEdit(agent)} data-testid="agent-edit">
          <Pencil size={13} /> Configure
        </Button>
      </div>
    </Card>
  );
}

/**
 * Agents tab — the roster of custom agents. List, create, edit, and launch a
 * run. This is where "what we want to do, where, how" lives.
 */
export function AgentsPanel({ brand, onRun }) {
  const [agents, setAgents] = useState(null);
  const [formats, setFormats] = useState([]);
  const [blocks, setBlocks] = useState([]);
  const [defaultPipelines, setDefaultPipelines] = useState(null);
  const [editing, setEditing] = useState(null); // agent object, or {} for new
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/agents?brand=${encodeURIComponent(brand || "")}`, { cache: "no-store" });
      if (!res.ok) throw new Error((await res.json()).detail || "Failed to load agents");
      const data = await res.json();
      setAgents(data.agents || []);
      setFormats(data.formats || []);
      setBlocks(data.blocks || []);
      setDefaultPipelines(data.default_pipelines || null);
    } catch (e) {
      setError(e.message);
      setAgents([]);
    }
  }, [brand]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (editing) {
    return (
      <AgentBuilder
        brand={brand}
        formats={formats}
        blocks={blocks}
        defaultPipelines={defaultPipelines}
        agent={editing.id ? editing : null}
        onCancel={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          refresh();
        }}
        onDeleted={() => {
          setEditing(null);
          refresh();
        }}
      />
    );
  }

  if (agents === null) {
    return (
      <div style={{ padding: "var(--space-7)", textAlign: "center" }}>
        <Loader2 size={18} style={{ color: "var(--text-3)", animation: "spin 1s linear infinite" }} />
      </div>
    );
  }

  return (
    <div data-testid="agents-panel">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--space-4)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          <Sparkles size={16} style={{ color: "var(--accent)" }} />
          <span style={{ fontSize: "13px", color: "var(--text-2)" }}>
            Build an operator for each job to be done. It runs on a crew of five specialists you can watch work.
          </span>
        </div>
        <Button variant="primary" size="sm" onClick={() => setEditing({})} data-testid="agent-new">
          <Plus size={14} /> New agent
        </Button>
      </div>

      {error && <div style={{ fontSize: "12px", color: "var(--crit)", marginBottom: "var(--space-3)" }}>{error}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "var(--space-4)" }}>
        {agents.map((a) => (
          <AgentCard key={a.id} agent={a} onEdit={setEditing} onRun={onRun} />
        ))}
      </div>
    </div>
  );
}
