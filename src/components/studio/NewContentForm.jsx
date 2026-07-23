"use client";

import { useEffect, useState } from "react";
import { Loader2, Sparkles, Play } from "lucide-react";
import { Card } from "@/components/perceev/Card";
import { Button } from "@/components/perceev/Button";
import { Input } from "@/components/perceev/Input";
import { Select } from "@/components/perceev/Select";
import { Badge } from "@/components/perceev/Badge";

/**
 * Run launcher — pick an agent, give it a topic (or target query), launch.
 * Replaces the v1 raw-playbook form: you now run a configured Agent, and the
 * base pipeline is inferred from it.
 */
export function NewContentForm({ brand, agents: agentsProp, presetAgentId, onLaunched }) {
  const [agents, setAgents] = useState(agentsProp || null);
  const [agentId, setAgentId] = useState(presetAgentId || "");
  const [topic, setTopic] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (agentsProp) {
      setAgents(agentsProp);
      return;
    }
    fetch(`/api/agents?brand=${encodeURIComponent(brand || "")}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { agents: [] }))
      .then((d) => setAgents(d.agents || []))
      .catch(() => setAgents([]));
  }, [brand, agentsProp]);

  useEffect(() => {
    if (!agentId && agents && agents.length) setAgentId(presetAgentId || agents[0].id);
  }, [agents, agentId, presetAgentId]);

  const agent = (agents || []).find((a) => a.id === agentId);
  const isGeo = agent?.base === "geo_article";

  const submit = async () => {
    if (!agentId) {
      setError("Pick an agent.");
      return;
    }
    if (!topic.trim()) {
      setError(isGeo ? "Enter a topic or the target query to win." : "Enter a topic.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const input = isGeo
        ? { type: "topic", query: topic.trim(), topic: topic.trim() }
        : { type: "topic", topic: topic.trim() };
      const res = await fetch("/api/content", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand, agent_id: agentId, input }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Failed to start run");
      onLaunched?.(data.job_id);
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card style={{ padding: "var(--space-7)", maxWidth: "560px" }} data-testid="studio-new-form">
      <h3 style={{ fontFamily: "var(--font-sans)", fontSize: "17px", fontWeight: 600, color: "var(--text-1)", marginBottom: "var(--space-2)" }}>
        Run an agent
      </h3>
      <p style={{ fontSize: "13px", color: "var(--text-2)", marginBottom: "var(--space-6)", lineHeight: 1.6 }}>
        The agent&apos;s crew runs Strategist → Researcher → Analyst → Writer → Editor, then queues
        the piece for your approval. Watch them work live.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
        <div>
          <Select label="Agent" value={agentId} onChange={(e) => setAgentId(e.target.value)} data-testid="new-agent-select">
            {(agents || []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.emoji} {a.name} — {a.format}
              </option>
            ))}
          </Select>
          {agent && (
            <div style={{ display: "flex", gap: "6px", marginTop: "var(--space-2)", flexWrap: "wrap" }}>
              <Badge variant="neutral">{agent.format}</Badge>
              {agent.channel && <Badge variant="muted">→ {agent.channel}</Badge>}
              {agent.length_hint && <Badge variant="muted">{agent.length_hint}</Badge>}
            </div>
          )}
        </div>

        <Input
          label={isGeo ? "Topic / target query to win" : "Topic"}
          data-testid="new-topic"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder={isGeo ? "e.g. best diagnostics chain for corporates" : "e.g. home-collection economics"}
        />

        {error && <div style={{ fontSize: "12px", color: "var(--crit)" }}>{error}</div>}

        <div>
          <Button variant="primary" size="md" onClick={submit} disabled={submitting} data-testid="new-launch">
            {submitting ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Play size={14} />}
            {submitting ? "Launching…" : "Launch run"}
          </Button>
        </div>
      </div>
    </Card>
  );
}
