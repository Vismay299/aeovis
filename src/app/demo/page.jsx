"use client";
import { useState } from "react";
import Link from "next/link";
import { AgentCanvas } from "@/components/studio/AgentCanvas";
import { AgentBuilder } from "@/components/studio/AgentBuilder";
import { FORMATS } from "@/lib/content/agents/formats";
import { BLOCKS, DEFAULT_PIPELINES } from "@/lib/content/agents/blocks";
import { builtinAgents } from "@/lib/content/agents/model";

export default function DemoPage() {
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [agents, setAgents] = useState(() => builtinAgents().map((agent,index) => ({ ...agent, id: `demo-${index}` })));
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
  return <main style={{ maxWidth: 1280, margin: "0 auto", padding: "40px 24px" }}>
    <Link href="/portal/scans">← Back to workspace</Link>
    <h1 style={{ fontSize: 36, margin: "24px 0 12px" }}>Test the scan & content workflow</h1>
    <p role="note">Simulation only. Answers, mentions and citations below are invented fixtures, not a measurement of Italica. No vendor calls, credits or saved scan history. Demo agents stay in this browser session.</p>
    <button onClick={run} disabled={busy} style={{ padding: "12px 20px", margin: "24px 0", borderRadius: 8, background: "var(--accent)", color: "var(--text-on-accent)" }}>{busy ? "Running mock scan…" : "Run mock scan"}</button>
    {error ? <p role="alert">{error}</p> : null}
    {result ? <section aria-label="Mock scan results">
      <h2>Mock scan complete</h2><p>{result.prompt_count} buyer questions · {result.answer_count} simulated answers · 4 engines</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap:16, margin:"20px 0" }}>
        {Object.entries(result.scan.engines || {}).map(([key, engine]) => <article key={key} style={{ padding:20, border:"1px solid var(--border-1)", borderRadius:12 }}><h3>{key === "aio" ? "Google AI Overviews" : key === "chatgpt" ? "ChatGPT" : key === "gemini" ? "Gemini" : "Perplexity"}</h3><p>{engine.share_of_ai_pct ?? engine.visibility_pct ?? "—"}% simulated visibility</p></article>)}
      </div>
      <details><summary>View simulated answers and citations</summary>{result.results.map((row) => <article key={row.id} style={{ margin:"12px 0" }}><strong>{row.engine} · {row.query}</strong><p>{row.raw.text}</p>{row.raw.references.map((ref) => <p key={ref.href}>Simulated citation: {ref.href}</p>)}</article>)}</details>
    </section> : null}
    <h2 style={{margin:"32px 0 16px"}}>Content workflow</h2><AgentCanvas />
    <h2 style={{margin:"32px 0 16px"}}>Agents & crew canvas</h2>
    {editing ? <AgentBuilder brand="demo" formats={Object.values(FORMATS)} blocks={Object.values(BLOCKS)} defaultPipelines={DEFAULT_PIPELINES} agent={editing.id ? editing : null} onCancel={() => setEditing(null)} onSaved={() => setEditing(null)} onDeleted={() => setEditing(null)} onPersist={async (form) => { const saved={...form,id:editing.id || crypto.randomUUID()};setAgents((prev) => [...prev.filter((a)=>a.id!==saved.id),saved]);return saved; }} onRemove={async(id)=>setAgents((prev)=>prev.filter((a)=>a.id!==id))} /> : <><button onClick={()=>setEditing({})}>New agent</button><div style={{ display:"flex",gap:12,flexWrap:"wrap",marginTop:16 }}>{agents.map((agent,index)=><button key={agent.id || index} onClick={()=>setEditing({...agent,id:agent.id || `demo-${index}`})} style={{border:"1px solid var(--border-1)",borderRadius:8,padding:20}}>{agent.emoji} {agent.name} · Configure</button>)}</div></>}
  </main>;
}
