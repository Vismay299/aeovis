"use client";

import { useEffect, useId, useState } from "react";
import { Sparkles } from "lucide-react";
import { Banner, Button, Card } from "../ui";
import { PLAYBOOK_OPTIONS, contentRequest, cx } from "./shared";

const TOPIC_MAX = 300;
const BRIEF_MAX = 8000;

/** "Create a draft": topic, format and the facts the draft must use. */
export default function ComposerCard({ brandKey, topicRef, onCreated, onUnauthorized, selectedAgent, onClearAgent, initialTopic = "" }) {
  const id = useId();
  const [topic, setTopic] = useState(initialTopic.slice(0, TOPIC_MAX));
  useEffect(() => { if (initialTopic) setTopic(initialTopic.slice(0, TOPIC_MAX)); }, [initialTopic]);
  const [brief, setBrief] = useState("");
  const [playbook, setPlaybook] = useState("geo_article");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event) {
    event.preventDefault();
    const query = topic.trim();
    if (!query || busy) return;
    setBusy(true);
    setError("");
    try {
      await contentRequest("/api/customer/content", {
        brandKey,
        method: "POST",
        body: { query, brief: brief.trim(), playbook: selectedAgent?.base || playbook,
          agent_id: selectedAgent?.id, template_slug: selectedAgent?.is_template ? selectedAgent.slug : undefined },
      });
      setTopic("");
      setBrief("");
      onCreated();
    } catch (err) {
      if (err.status === 401) onUnauthorized();
      else setError(err.message || "Could not start the draft.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Create a draft">
      {selectedAgent ? <Banner title={`Run ${selectedAgent.name}`} action={<Button size="sm" variant="secondary" onClick={onClearAgent}>Use default</Button>}>{selectedAgent.format} · {selectedAgent.channel}</Banner> : null}
      <form className="pv-content-form" onSubmit={submit}>
        {error ? <Banner tone="error" onDismiss={() => setError("")}>{error}</Banner> : null}

        <div className="pv-field">
          <div className="pv-content-label-row">
            <label className="pv-label" htmlFor={`${id}-topic`}>Topic</label>
            <span className={cx("pv-content-counter", topic.length >= TOPIC_MAX ? "is-full" : topic.length >= TOPIC_MAX * 0.9 && "is-near")}>
              {topic.length}/{TOPIC_MAX}
            </span>
          </div>
          <input
            id={`${id}-topic`}
            ref={topicRef}
            className="pv-input"
            required
            maxLength={TOPIC_MAX}
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            placeholder="e.g. Best CRM for small accounting firms"
            autoComplete="off"
          />
        </div>

        <div className="pv-field">
          <label className="pv-label" htmlFor={`${id}-format`}>Format</label>
          <select id={`${id}-format`} className="pv-select" value={selectedAgent?.base || playbook} disabled={Boolean(selectedAgent)} onChange={(event) => setPlaybook(event.target.value)}>
            {PLAYBOOK_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>

        <div className="pv-field">
          <div className="pv-content-label-row">
            <label className="pv-label" htmlFor={`${id}-brief`}>Brief &amp; product facts</label>
            <span className={cx("pv-content-counter", brief.length >= BRIEF_MAX ? "is-full" : brief.length >= BRIEF_MAX * 0.9 && "is-near")}>
              {brief.length}/{BRIEF_MAX}
            </span>
          </div>
          <textarea
            id={`${id}-brief`}
            className="pv-textarea"
            rows={5}
            maxLength={BRIEF_MAX}
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
          />
          <span className="pv-hint">Facts, proof points and links the draft must use. It will not invent claims.</span>
        </div>

        <Button type="submit" block icon={Sparkles} loading={busy} disabled={!topic.trim()}>
          Generate draft
        </Button>
      </form>
    </Card>
  );
}
