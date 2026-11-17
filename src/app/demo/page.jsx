"use client";
import { useState } from "react";
import { Plus, Pencil } from "lucide-react";
import { PageFrame } from "@/components/design-system/PageFrame";
import { Banner, Button, Card, PageHeader } from "@/components/portal/ui";
import MockScanPanel from "@/components/portal/scans/MockScanPanel";
import { AgentCanvas } from "@/components/studio/AgentCanvas";
import { AgentBuilder } from "@/components/studio/AgentBuilder";
import { FORMATS } from "@/shared/content/agents/formats";
import { BLOCKS, DEFAULT_PIPELINES } from "@/shared/content/agents/blocks";
import { builtinAgents } from "@/shared/content/agents/model";
import "./demo.css";

export default function DemoPage() {
  const [agents, setAgents] = useState(() => builtinAgents().map((agent, index) => ({ ...agent, id: `demo-${index}` })));
  const [editing, setEditing] = useState(null);

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
      <MockScanPanel />
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
