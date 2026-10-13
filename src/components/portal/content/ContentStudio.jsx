"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Plus } from "lucide-react";
import { usePortal } from "../PortalShell";
import { Banner, Button, Card, PageHeader, SkeletonRows } from "../ui";
import { CONTENT_JOB_ACTIVE } from "../status";
import { contentRequest } from "./shared";
import ComposerCard from "./ComposerCard";
import GenerationQueue from "./GenerationQueue";
import DraftsLibrary from "./DraftsLibrary";
import DraftEditor from "./DraftEditor";
import "./content.css";
import { AgentsPanel } from "@/components/studio/AgentsPanel";
import { AgentCanvas } from "@/components/studio/AgentCanvas";

const POLL_ACTIVE_MS = 4000;
const POLL_IDLE_MS = 20000;
const UNSAVED_MESSAGE = "You have unsaved changes. Leave without saving?";

const isActive = (job) => CONTENT_JOB_ACTIVE.includes(job.status);

/**
 * Content Studio page body. Owns the list and job data (polled only while a
 * job runs), the ?item= / ?new= URL state and the success notices.
 */
export default function ContentStudio() {
  const { brandKey, refreshOverview, redirectToLogin } = usePortal();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selectedId = searchParams.get("item") || "";
  const focusRequested = searchParams.get("new") === "1";

  const [studioTab, setStudioTab] = useState(() => selectedId || focusRequested ? "drafts" : "workspace");
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [items, setItems] = useState(null);
  const [jobs, setJobs] = useState(null);
  const [listError, setListError] = useState("");
  const [notices, setNotices] = useState([]);
  const topicRef = useRef(null);
  const previousActive = useRef(new Map()); // job id -> topic, for jobs seen running
  const dirtyRef = useRef(false);
  const loadGeneration = useRef(0);

  const hasActive = useMemo(() => (jobs || []).some(isActive), [jobs]);

  const load = useCallback(async () => {
    if (!brandKey) return;
    const generation = ++loadGeneration.current;
    try {
      const data = await contentRequest("/api/customer/content", { brandKey });
      if (generation !== loadGeneration.current) return;
      const nextJobs = data.jobs || [];
      setItems(data.items || []);
      setJobs(nextJobs);
      setListError("");

      // Jobs that were running and are no longer running have finished.
      const before = previousActive.current;
      const after = new Map(nextJobs.filter(isActive).map((job) => [job.id, job.input?.query || ""]));
      previousActive.current = after;
      const ended = [...before.keys()].filter((id) => !after.has(id));
      if (ended.length) {
        const ready = ended.flatMap((id) => {
          const job = nextJobs.find((entry) => entry.id === id);
          return job?.status === "awaiting_approval" && job.item_id
            ? [{ key: id, itemId: job.item_id, topic: before.get(id) }]
            : [];
        });
        if (ready.length) {
          setNotices((prev) => [...ready, ...prev.filter((notice) => !ready.some((entry) => entry.key === notice.key))]);
        }
        refreshOverview();
      }
    } catch (err) {
      if (generation !== loadGeneration.current) return;
      if (err.status === 401) {
        redirectToLogin();
        return;
      }
      setListError(err.message || "Could not load Content Studio.");
      setItems((prev) => prev || []);
      setJobs((prev) => prev || []);
    }
  }, [brandKey, redirectToLogin, refreshOverview]);

  // A different workspace starts from a clean slate.
  useEffect(() => {
    setStudioTab("workspace");
    setSelectedAgent(null);
    setItems(null);
    setJobs(null);
    setNotices([]);
    previousActive.current = new Map();
  }, [brandKey]);

  // Poll fast while a job is running, slowly otherwise.
  useEffect(() => {
    if (!brandKey) return undefined;
    const generation = loadGeneration;
    load();
    const timer = setInterval(load, hasActive ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    return () => { clearInterval(timer); generation.current++; };
  }, [brandKey, hasActive, load]);

  const focusComposer = useCallback(() => {
    setStudioTab("drafts");
    requestAnimationFrame(() => {
      const field = topicRef.current;
      if (!field) return;
      field.focus();
      field.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }, []);

  useEffect(() => {
    if (focusRequested) focusComposer();
    else if (selectedId) setStudioTab("drafts");
  }, [focusRequested, selectedId, brandKey, focusComposer]);

  const setUrlParams = useCallback((changes) => {
    const params = new URLSearchParams(searchParams.toString());
    Object.entries(changes).forEach(([key, value]) => {
      if (value) params.set(key, value);
      else params.delete(key);
    });
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [pathname, router, searchParams]);

  /** Opens (or with "" closes) a draft. Returns false if the user kept unsaved edits. */
  const changeDraft = useCallback((id) => {
    if (dirtyRef.current && !window.confirm(UNSAVED_MESSAGE)) return false;
    setUrlParams({ item: id, new: "" });
    return true;
  }, [setUrlParams]);

  const reportDirty = useCallback((dirty) => { dirtyRef.current = dirty; }, []);

  const dismissNotice = useCallback((key) => {
    setNotices((prev) => prev.filter((notice) => notice.key !== key));
  }, []);

  const refreshAll = useCallback(() => {
    load();
    refreshOverview();
  }, [load, refreshOverview]);

  const generating = Boolean(selectedId) && (jobs || []).some((job) => job.item_id === selectedId && isActive(job));

  if (!brandKey) return <SkeletonRows rows={3} />;

  return (
    <>
      <PageHeader
        title="Content Studio"
        description="Turn the questions AI engines answer without you into articles they can cite."
        actions={<Button icon={Plus} onClick={focusComposer}>New draft</Button>}
      />

      {listError ? (
        <Banner tone="error" title="Content Studio did not refresh" action={<Button size="sm" variant="secondary" onClick={load}>Try again</Button>}>
          {listError}
        </Banner>
      ) : null}

      <div className="pv-content-tabs" role="tablist" aria-label="Content Studio views">
        {[ ["workspace", "Workspace & canvas"], ["drafts", "Drafts"], ["agents", "Agents & crew canvas"] ].map(([key, label]) => (
          <button key={key} role="tab" aria-selected={studioTab === key} onClick={() => setStudioTab(key)}>{label}</button>
        ))}
      </div>
      {studioTab === "workspace" ? <Card title="Content workflow" description="Research, draft and review, with your approval before anything is published.">
        <AgentCanvas run={{ status: jobs?.find(isActive)?.status, query: jobs?.find(isActive)?.input?.query }} />
      </Card> : null}
      {studioTab === "workspace" || studioTab === "agents" ? <section className="pv-studio-agents" aria-label="Workspace agents"><AgentsPanel key={brandKey} brand={brandKey} customer apiBase="/api/customer/agents" onRun={(agent) => { setSelectedAgent(agent); focusComposer(); }} /></section> : null}
      <div hidden={studioTab !== "drafts"} className="pv-grid pv-grid--main-side pv-content-layout">
        <div className="pv-content-main">
          {notices.length ? (
            <div className="pv-content-notices">
              {notices.map((notice) => (
                <Banner
                  key={notice.key}
                  tone="success"
                  title="Your draft is ready for review"
                  onDismiss={() => dismissNotice(notice.key)}
                  action={
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => { if (changeDraft(notice.itemId)) dismissNotice(notice.key); }}
                    >
                      Open draft
                    </Button>
                  }
                >
                  {notice.topic ? `"${notice.topic}" is written and waiting for your review.` : "A new draft is waiting for your review."}
                </Banner>
              ))}
            </div>
          ) : null}

          {selectedId ? (
            <DraftEditor
              key={selectedId}
              brandKey={brandKey}
              itemId={selectedId}
              generating={generating}
              onClose={() => changeDraft("")}
              onChanged={refreshAll}
              onUnauthorized={redirectToLogin}
              onDirtyChange={reportDirty}
            />
          ) : (
            <DraftsLibrary items={items} onOpen={changeDraft} />
          )}
        </div>

        <div className="pv-stack">
          <ComposerCard
            initialTopic={searchParams.get("topic") || ""}
            selectedAgent={selectedAgent}
            onClearAgent={() => setSelectedAgent(null)}
            topicRef={topicRef}
            brandKey={brandKey}
            onCreated={refreshAll}
            onUnauthorized={redirectToLogin}
          />
          <GenerationQueue jobs={jobs} />
        </div>
      </div>
    </>
  );
}
