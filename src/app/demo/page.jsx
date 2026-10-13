"use client";
import { useState } from "react";
import { Play, Plus, Pencil } from "lucide-react";
import { PageFrame } from "@/components/design-system/PageFrame";
import { Banner, Button, Card, PageHeader, Stat } from "@/components/portal/ui";
import { engineLabel } from "@/components/portal/scans/reportData";
import { AgentCanvas } from "@/components/studio/AgentCanvas";
import { AgentBuilder } from "@/components/studio/AgentBuilder";
import { FORMATS } from "@/lib/content/agents/formats";
import { BLOCKS, DEFAULT_PIPELINES } from "@/lib/content/agents/blocks";
import { builtinAgents } from "@/lib/content/agents/model";
import "./demo.css";

export default function DemoPage() {
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [agents, setAgents] = useState(() => builtinAgents().map((agent, index) => ({ ...agent, id: `demo-${index}` })));
  const [editing, setEditing] = useState(null);

  async function run() {
    setBusy(true); setError(""); setResult(null);
    try {
      const response = await fetch("/api/demo/scan", { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Mock scan failed");
      setResult(body);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  async function saveAgent(form) {
    const saved = { ...form, id: editing.id || crypto.randomUUID() };
    setAgents((previous) => [...previous.filter((agent) => agent.id !== saved.id), saved]);
    return saved;
  }

  return <PageFrame>
    <PageHeader eyebrow="Product demo" title="Test the scan & content workflow"
      description="Explore the same scans, reports and agent builder used in your workspace."
      actions={<Button href="/portal/scans" variant="secondary">Back to workspace</Button>} />
    <div className="pv-stack">
      <Banner title="Simulation only">Answers, mentions and citations are invented fixtures, not a measurement of Italica. No vendor calls, credits or saved scan history. Demo agents stay in this browser session.</Banner>
      <Card title="Run a mock scan" description="30 buyer questions across Google AI Overviews, ChatGPT, Gemini and Perplexity."
        actions={<Button onClick={run} loading={busy} icon={Play}>Run mock scan</Button>}>
        {error ? <Banner tone="error">{error}</Banner> : null}
        {result ? <section aria-label="Mock scan results">
          <Banner tone="success" title="Mock scan complete">{result.prompt_count} buyer questions · {result.answer_count} simulated answers · 4 engines</Banner>
          <div className="pv-grid pv-grid--4 demo-engine-grid">
            {Object.entries(result.scan.engines || {}).map(([key, engine]) => <Stat key={key} label={engineLabel(key)}
              value={engine.share_of_ai_pct ?? engine.visibility_pct} suffix="%" sub="Simulated visibility" />)}
          </div>
          <details className="demo-answers"><summary>View simulated answers and citations</summary>
            {result.results.map((row) => <article key={row.id}>
              <strong>{engineLabel(row.engine)} · {row.query}</strong><p>{row.raw.text}</p>
              {row.raw.references.map((ref) => <p key={ref.href}>Simulated citation: {ref.href}</p>)}
            </article>)}
          </details>
        </section> : <p className="pv-hint">Run the demo to see engine coverage, simulated visibility and answer evidence.</p>}
      </Card>
      <Card title="Content workflow" description="Research, draft and review, with a human approval gate.">
        <AgentCanvas title="Workflow canvas" />
      </Card>
      <Card title="Agents & crew canvas" description="Configure output formats, instructions and the specialists in each workflow."
        actions={!editing ? <Button icon={Plus} onClick={() => setEditing({})}>New agent</Button> : null}>
        {editing ? <AgentBuilder brand="demo" formats={Object.values(FORMATS)} blocks={Object.values(BLOCKS)}
          defaultPipelines={DEFAULT_PIPELINES} agent={editing.id ? editing : null}
          onCancel={() => setEditing(null)} onSaved={() => setEditing(null)} onDeleted={() => setEditing(null)}
          onPersist={saveAgent} onRemove={async (id) => setAgents((previous) => previous.filter((agent) => agent.id !== id))} />
          : <div className="pv-grid pv-grid--2">
              {agents.map((agent) => <Card key={agent.id} title={`${agent.emoji} ${agent.name}`} description={agent.description}
                footer={<Button size="sm" variant="secondary" icon={Pencil} onClick={() => setEditing(agent)}>Configure {agent.name}</Button>}>
                <p>{agent.format} · {agent.channel}</p>
              </Card>)}
            </div>}
      </Card>
    </div>
  </PageFrame>;
}
