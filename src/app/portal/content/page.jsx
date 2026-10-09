"use client";
import Link from "next/link";
import { useEffect, useState } from "react";

export default function CustomerContentStudio() {
  const [key, setKey] = useState("");
  const [topic, setTopic] = useState("");
  const [brief, setBrief] = useState("");
  const [items, setItems] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [item, setItem] = useState(null);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  useEffect(() => { setKey(new URLSearchParams(window.location.search).get("brand_key") || ""); }, []);
  async function call(path, options) {
    const response = await fetch(`${path}${path.includes("?") ? "&" : "?"}brand_key=${encodeURIComponent(key)}`, { cache: "no-store", ...options });
    if (response.status === 401) { window.location.assign("/login?next=" + encodeURIComponent(window.location.pathname + window.location.search)); throw new Error("Please sign in."); }
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || "Request failed.");
    return value;
  }
  useEffect(() => {
    if (!key) return;
    let active = true;
    const load = async () => {
      try {
        const response = await fetch(`/api/customer/content?brand_key=${encodeURIComponent(key)}`, { cache: "no-store" });
        if (response.status === 401) { window.location.assign("/login"); return; }
        const value = await response.json();
        if (!response.ok) throw new Error(value.error || "Could not load drafts.");
        if (active) { setItems(value.items); setJobs(value.jobs); }
      } catch (err) { if (active) setError(err.message); }
    };
    load();
    const timer = setInterval(load, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [key]);
  async function action(work) {
    setWorking(true); setError("");
    try { await work(); } catch (err) { setError(err.message); } finally { setWorking(false); }
  }
  const json = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return <main className="customer-portal-page">
    <header className="customer-portal-header"><Link href="/portal">← Workspace</Link><h1>Content Studio</h1></header>
    <div className="customer-portal-content">
      {error && <p role="alert" className="customer-portal-alert">{error}</p>}
      <section className="customer-portal-panel">
        <h2>Create a draft</h2><p>Describe the article and provide the facts it should use.</p>
        <form className="customer-auth-form" onSubmit={(event) => { event.preventDefault(); action(async () => {
          await call("/api/customer/content", json("POST", { brand_key: key, query: topic, brief })); setTopic(""); setBrief("");
        }); }}>
          <label htmlFor="content-topic">Topic</label><input id="content-topic" required maxLength={300} value={topic} onChange={(event) => setTopic(event.target.value)} />
          <label htmlFor="content-brief">Brief and product facts</label><textarea id="content-brief" rows={5} maxLength={8000} value={brief} onChange={(event) => setBrief(event.target.value)} />
          <button className="btn btn--primary" disabled={working || !key}>Generate article</button>
        </form>
        {jobs.map((job) => <p key={job.id}>{job.status} · {job.progress_pct || 0}%{job.error_message ? ` · ${job.error_message}` : ""}</p>)}
      </section>
      <section className="customer-portal-panel"><h2>Drafts</h2>
        {items.length === 0 && <p>No drafts yet. Generation progress appears above.</p>}
        {items.map((draft) => <p key={draft.id}><button className="customer-auth-link" disabled={working} onClick={() => action(async () => setItem((await call(`/api/customer/content/${draft.id}`)).item))}>{draft.title || "Untitled draft"}</button> · {draft.status}</p>)}
      </section>
      {item && <section className="customer-portal-panel"><h2>Review draft</h2>
        <form className="customer-auth-form" onSubmit={(event) => { event.preventDefault(); action(async () => {
          await call(`/api/customer/content/${item.id}`, json("PATCH", { title: item.title, body_md: item.body_md })); setItem((await call(`/api/customer/content/${item.id}`)).item);
        }); }}>
          <label htmlFor="draft-title">Title</label><input id="draft-title" required value={item.title || ""} onChange={(event) => setItem({ ...item, title: event.target.value })} />
          <label htmlFor="draft-text">Draft (Markdown)</label><textarea id="draft-text" rows={22} value={item.body_md || ""} onChange={(event) => setItem({ ...item, body_md: event.target.value })} />
          <button className="btn btn--primary" disabled={working}>Save edits</button>
        </form>
        <p>Status: {item.status}. Approval saves your review; it does not publish to your website.</p>
        {["approved", "rejected"].map((verdict) => <button key={verdict} className="customer-auth-link" disabled={working || item.status !== "awaiting_approval"} onClick={() => action(async () => {
          await call(`/api/customer/content/${item.id}`, json("POST", { verdict })); setItem((await call(`/api/customer/content/${item.id}`)).item);
        })}>{verdict === "approved" ? "Approve" : "Reject"}</button>)}
        <p><a href={`/api/customer/content/${item.id}?brand_key=${encodeURIComponent(key)}&export=markdown`}>Download Markdown</a></p>
      </section>}
    </div>
  </main>;
}
