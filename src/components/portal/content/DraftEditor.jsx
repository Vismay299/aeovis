"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, Download, X } from "lucide-react";
import { Markdown } from "@/components/studio/Markdown";
import { Badge, Banner, Button, Skeleton, Tabs, formatRelative } from "../ui";
import { contentItemStatus } from "../status";
import { contentRequest, countWords, cx, playbookLabel, readingMinutes } from "./shared";
import ReviewFindings from "./ReviewFindings";
import IndexNowOffer from "./IndexNowOffer";
import { trackEvent } from "@/lib/telemetry/client";

/** Statuses the customer API accepts edits for (PATCH). */
const EDITABLE_STATUSES = ["draft", "awaiting_approval", "approved", "rejected"];
const MODES = [
  { value: "edit", label: "Edit" },
  { value: "preview", label: "Preview" },
  { value: "split", label: "Split" },
];

/**
 * The open draft. Owns its server copy and the local edits; the parent owns
 * the URL and tells us via onDirtyChange so it can guard navigation.
 */
export default function DraftEditor({ brandKey, itemId, generating, onClose, onChanged, onUnauthorized, onDirtyChange }) {
  const [item, setItem] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [mode, setMode] = useState("edit");
  const [saving, setSaving] = useState(false);
  const [deciding, setDeciding] = useState("");
  const [actionError, setActionError] = useState("");
  const [message, setMessage] = useState("");
  const [checking, setChecking] = useState(false);
  const [publishUrl, setPublishUrl] = useState("");
  const [publishedUrl, setPublishedUrl] = useState(null);
  const [publishing, setPublishing] = useState(false);

  const applyItem = useCallback((next) => {
    setItem(next);
    setTitle(next.title || "");
    setBody(next.body_md || "");
  }, []);

  const fetchItem = useCallback(
    () => contentRequest(`/api/customer/content/${itemId}`, { brandKey }).then((data) => data.item),
    [brandKey, itemId],
  );

  const refresh = useCallback(async () => {
    try {
      applyItem(await fetchItem());
      setLoadError("");
    } catch (err) {
      if (err.status === 401) onUnauthorized();
      else setLoadError(err.message || "Could not open this draft.");
    }
  }, [applyItem, fetchItem, onUnauthorized]);

  // Initial load for this draft.
  useEffect(() => {
    let live = true;
    fetchItem()
      .then((next) => {
        if (!live) return;
        applyItem(next);
        setLoadError("");
      })
      .catch((err) => {
        if (!live) return;
        if (err.status === 401) onUnauthorized();
        else setLoadError(err.message || "Could not open this draft.");
      });
    return () => { live = false; };
  }, [applyItem, fetchItem, onUnauthorized]);

  // Pull the finished draft once generation ends.
  const wasGenerating = useRef(generating);
  useEffect(() => {
    if (wasGenerating.current && !generating) refresh();
    wasGenerating.current = generating;
  }, [generating, refresh]);

  const dirty = Boolean(item) && (title !== (item.title || "") || body !== (item.body_md || ""));

  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  // Warn before a full page unload while there are unsaved edits.
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const editable = Boolean(item) && EDITABLE_STATUSES.includes(item.status) && !generating;
  const status = contentItemStatus(item?.status);
  const words = countWords(body);
  const canSave = editable && dirty && title.trim().length > 0 && !saving && !deciding;
  const canDecide = Boolean(item) && item.status === "awaiting_approval" && !dirty && !generating && !saving && !deciding;
  const exportUrl = `/api/customer/content/${itemId}?brand_key=${encodeURIComponent(brandKey)}&export=markdown`;

  async function save() {
    setSaving(true);
    setActionError("");
    setMessage("");
    try {
      await contentRequest(`/api/customer/content/${itemId}`, {
        brandKey,
        method: "PATCH",
        body: { title: title.trim(), body_md: body, content_version: item.content_version },
      });
      await refresh();
      setMessage("Saved. The draft is back in Needs review until you approve it.");
      onChanged();
    } catch (err) {
      if (err.status === 401) onUnauthorized();
      else setActionError(err.message || "Could not save this draft.");
    } finally {
      setSaving(false);
    }
  }

  async function decide(verdict) {
    if (verdict === "rejected" && !window.confirm("Reject this draft? It stays in your library, marked Rejected.")) return;
    setDeciding(verdict);
    setActionError("");
    setMessage("");
    try {
      await contentRequest(`/api/customer/content/${itemId}`, { brandKey, method: "POST", body: { verdict, content_version: item.content_version, content_hash: item.content_hash } });
      await refresh();
      trackEvent("content:review_submitted", { verdict });
      setMessage(verdict === "approved"
        ? "Review recorded as approved. Nothing was published to your website."
        : "Review recorded as rejected.");
      onChanged();
    } catch (err) {
      if (err.status === 401) onUnauthorized();
      else setActionError(err.message || "Could not save your review.");
    } finally {
      setDeciding("");
    }
  }

  async function checkedAction(action) {
    const setBusy = action === "check" ? setChecking : setPublishing;
    setBusy(true); setActionError(""); setMessage("");
    try {
      const data = await contentRequest(`/api/customer/content/${itemId}/${action}`, {brandKey, method:"POST", body:{
        content_version:item.content_version, content_hash:item.content_hash, ...(action === "publish" ? {url:publishUrl} : {})
      }});
      await refresh(); onChanged();
      setMessage(action === "publish" ? "Publication verified and recorded. Indexing and citations need separate observations." :
        data.check?.passed ? "This saved version passed its evidence check. Review it before approval." : "Check finished with issues. Resolve them before approval.");
      if (action === "publish") setPublishedUrl(data?.publication?.url ?? null);
    } catch(err) { if(err.status === 401) onUnauthorized(); else setActionError(err.message || "Action could not be completed."); }
    finally { setBusy(false); }
  }

  return (
    <section className="pv-card overflow-hidden rounded-xl border border-border bg-card shadow-sm" aria-label="Draft editor">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={() => onClose()}>All drafts</Button>
        {item ? <Tabs items={MODES} value={mode} onChange={setMode} label="Draft view" /> : null}
      </div>

      {loadError && !item ? (
        <div className="space-y-2.5 px-4 pt-4">
          <Banner tone="error" title="Could not open this draft" action={<Button size="sm" variant="secondary" onClick={refresh}>Try again</Button>}>
            {loadError}
          </Banner>
        </div>
      ) : null}

      {!item && !loadError ? (
        <div className="grid gap-3.5 p-6" aria-busy="true" aria-label="Loading draft">
          <Skeleton width="62%" height={26} />
          <Skeleton width={150} height={20} />
          <Skeleton height={380} />
        </div>
      ) : null}

      {item ? (
        <>
          <div className="space-y-2.5 px-4 pt-4">
            <p role="status" className="text-sm text-muted-foreground">Evidence check: {item.rubric?.check?.passed && item.rubric.check.content_hash === item.content_hash ? "passed for this version" : "required before approval"} · Version {item.content_version || "legacy"}</p>
            {(item.rubric?.check?.issues || []).map((issue,i) => <p key={i} className="text-sm text-muted-foreground">{issue.detail || issue.claim || issue.description || issue.type || "Review supporting evidence"}</p>)}
            <Button size="sm" variant="secondary" disabled={dirty || checking || saving || generating || publishing || item.status === "published"} onClick={() => checkedAction("check")}>{checking ? "Checking…" : "Check saved draft"}</Button>
            {item.status === "approved" && !dirty ? <div className="flex flex-wrap items-end gap-2">
              <label className="grid gap-1 text-sm font-medium">Published page URL<input aria-label="Published page URL" className="h-9 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-base text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm" type="url" value={publishUrl} onChange={e=>setPublishUrl(e.target.value)} /></label>
              <Button size="sm" disabled={!publishUrl || publishing} onClick={()=>checkedAction("publish")}>{publishing ? "Verifying…" : "Verify publication"}</Button>
            </div> : null}
            {publishedUrl ? <IndexNowOffer brandKey={brandKey} url={publishedUrl} contentItemId={itemId} /> : null}
          </div>
          <div className="grid gap-2.5 px-6 pb-1 pt-6">
            <input
              className="w-full min-w-0 rounded-lg border border-transparent bg-transparent px-2 py-1.5 text-xl font-semibold tracking-tight text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 read-only:cursor-default"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              readOnly={!editable || saving || Boolean(deciding)}
              maxLength={300}
              placeholder="Untitled draft"
              aria-label="Draft title"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={status.tone} dot>{status.label}</Badge>
              <span className="text-xs text-muted-foreground">
                {[playbookLabel(item.playbook, item.agent_snapshot?.format), `Updated ${formatRelative(item.updated_at)}`].filter(Boolean).join(" · ")}
              </span>
            </div>
          </div>

          {generating || !editable || message || actionError ? (
            <div className="space-y-2.5 px-4 pt-4">
              {generating ? (
                <Banner tone="info" title="Still being written">
                  This draft unlocks for editing when the writer finishes.
                </Banner>
              ) : null}
              {!generating && !editable ? (
                <Banner tone="info">This draft is {status.label.toLowerCase()} and cannot be edited right now.</Banner>
              ) : null}
              {message ? <Banner tone="success" onDismiss={() => setMessage("")}>{message}</Banner> : null}
              {actionError ? <Banner tone="error" onDismiss={() => setActionError("")}>{actionError}</Banner> : null}
            </div>
          ) : null}

          <ReviewFindings rubric={item.rubric} />
          <div className={cx("grid gap-4 px-6 pb-6 pt-4", mode === "split" && "lg:grid-cols-2")}>
            {mode !== "preview" ? (
              <textarea
                className="min-h-[480px] w-full min-w-0 resize-y rounded-lg border border-input bg-background px-4 py-3 font-mono text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 read-only:bg-muted/40 read-only:text-muted-foreground"
                value={body}
                onChange={(event) => setBody(event.target.value)}
                readOnly={!editable || saving || Boolean(deciding)}
                spellCheck
                placeholder="Start writing in Markdown…"
                aria-label="Draft body"
              />
            ) : null}
            {mode !== "edit" ? (
              <article className="min-h-[480px] max-h-[760px] min-w-0 overflow-auto rounded-lg border border-border bg-card px-5 py-4 text-[15px] leading-relaxed break-words text-muted-foreground [&_code]:font-mono [&_p]:mb-3" aria-label="Preview">
                {body.trim() ? <Markdown>{`# ${title || "Untitled draft"}\n\n${body}`}</Markdown> : <p className="text-muted-foreground">Nothing to preview yet.</p>}
              </article>
            ) : null}
          </div>

          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/30 px-6 py-3.5">
            <span className="text-xs tabular-nums text-muted-foreground">
              {words === 0 ? "Empty draft" : `${words.toLocaleString()} words · ${readingMinutes(words)} min read`}
            </span>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button variant="secondary" href={exportUrl} icon={Download}>Download .md</Button>
              <Button variant="secondary" loading={saving} disabled={!canSave} onClick={save}>Save changes</Button>
              <Button variant="danger" icon={X} loading={deciding === "rejected"} disabled={!canDecide || checking || publishing} onClick={() => decide("rejected")}>
                Reject
              </Button>
              <Button variant="primary" icon={Check} loading={deciding === "approved"} onClick={() => decide("approved")} disabled={!canDecide || checking || publishing || !item.rubric?.check?.passed || item.rubric.check.content_hash !== item.content_hash}>
                Approve
              </Button>
            </div>
            <p className="basis-full text-xs leading-relaxed text-muted-foreground">
              Approving records your review. It does not publish anything to your website.
              {dirty ? " Save your changes before you approve or reject." : ""}
            </p>
          </footer>
        </>
      ) : null}
    </section>
  );
}
