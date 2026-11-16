"use client";

import { useEffect, useId, useState } from "react";
import { Sparkles } from "lucide-react";
import { Banner, Button, Card } from "../ui";
import { PLAYBOOK_OPTIONS, contentRequest, cx } from "./shared";
import { FORMATS } from "@/lib/content/agents/formats";

const TOPIC_MAX = 300;
const BRIEF_MAX = 8000;

// The shipped Input primitive's class list, copied because these controls stay
// native: the render harness finds the <option> elements by type.
const INPUT_CLASSES =
  "w-full min-w-0 rounded-lg border border-input bg-background px-3 py-1 text-base text-foreground transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40";

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
      <form className="grid gap-4" onSubmit={submit}>
        {error ? <Banner tone="error" onDismiss={() => setError("")}>{error}</Banner> : null}

        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <label className="text-sm font-medium" htmlFor={`${id}-topic`}>Topic</label>
            <span className={cx("font-mono text-[11.5px] tabular-nums", topic.length >= TOPIC_MAX ? "text-destructive" : topic.length >= TOPIC_MAX * 0.9 ? "text-warning" : "text-muted-foreground")}>
              {topic.length}/{TOPIC_MAX}
            </span>
          </div>
          <input
            id={`${id}-topic`}
            ref={topicRef}
            className={cx(INPUT_CLASSES, "h-10")}
            required
            maxLength={TOPIC_MAX}
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            placeholder="e.g. Best CRM for small accounting firms"
            autoComplete="off"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor={`${id}-format`}>Format</label>
          <select
            id={`${id}-format`}
            className={cx(INPUT_CLASSES, "h-10 pr-8")}
            value={selectedAgent?.base || playbook}
            disabled={Boolean(selectedAgent)}
            onChange={(event) => setPlaybook(event.target.value)}
          >
            {selectedAgent ? <option value={selectedAgent.base}>{FORMATS[selectedAgent.format]?.label || selectedAgent.format}</option> : PLAYBOOK_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <label className="text-sm font-medium" htmlFor={`${id}-brief`}>Brief &amp; product facts</label>
            <span className={cx("font-mono text-[11.5px] tabular-nums", brief.length >= BRIEF_MAX ? "text-destructive" : brief.length >= BRIEF_MAX * 0.9 ? "text-warning" : "text-muted-foreground")}>
              {brief.length}/{BRIEF_MAX}
            </span>
          </div>
          <textarea
            id={`${id}-brief`}
            className={cx(INPUT_CLASSES, "min-h-[124px] resize-y py-2")}
            rows={5}
            maxLength={BRIEF_MAX}
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
          />
          <span className="text-xs text-muted-foreground">Facts, proof points and links the draft must use. It will not invent claims.</span>
        </div>

        <Button type="submit" block icon={Sparkles} loading={busy} disabled={!topic.trim()}>
          Generate draft
        </Button>
      </form>
    </Card>
  );
}
