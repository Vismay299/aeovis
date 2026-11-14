"use client";

import { useCallback, useEffect, useState, useRef } from "react";
import { usePortal } from "@/components/portal/PortalShell";
import { Badge, Banner, Button, Card, PageHeader, Skeleton } from "@/components/portal/ui";
import { QuestionsWorkspace } from "@/components/portal/questions/QuestionsWorkspace";

export default function MeasurementPage() {
  const { brandKey, brand, redirectToLogin, scan, features } = usePortal();
  const activeBrand = useRef(brandKey), generation = useRef(0);
  activeBrand.current = brandKey;
  const [loadedBrand, setLoadedBrand] = useState(null);
  const [panels, setPanels] = useState([]),
    [sources, setSources] = useState([]),
    [opportunities, setOpportunities] = useState([]),
    [publications, setPublications] = useState([]);
  const [history, setHistory] = useState(null),
    [technical, setTechnical] = useState([]);
  const [persona, setPersona] = useState(""),
    [questions, setQuestions] = useState(""),
    [country, setCountry] = useState("in"),
    [language, setLanguage] = useState("en"),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false);
  const [url, setUrl] = useState(""),
    [sourceId, setSourceId] = useState(""),
    [passage, setPassage] = useState(""),
    [target, setTarget] = useState(""),
    [owner, setOwner] = useState(""),
    [mechanism, setMechanism] = useState("");

  const call = useCallback(
    async (kind, body) => {
      const r = await fetch(
        `/api/customer/repairs/${kind}?brand_key=${encodeURIComponent(brandKey)}`,
        {
          method: body ? "POST" : "GET",
          cache: "no-store",
          ...(body
            ? {
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
              }
            : {}),
        },
      );
      const d = await r.json();
      if (r.status === 401) redirectToLogin();
      if (!r.ok) throw Error(d.error || "Could not load workflow");
      return d;
    },
    [brandKey, redirectToLogin],
  );

  const load = useCallback(async () => {
    const request = ++generation.current, scope = brandKey;
    setLoaded(false);
    try {
      const rows = await Promise.all(
        [
          "panel",
          "source_snapshot",
          "opportunity",
          "publication",
          "technical_audit",
        ].map((k) => call(k)),
      );
      const r = await fetch(
        `/api/customer/measurement?brand_key=${encodeURIComponent(brandKey)}`,
        { cache: "no-store" },
      );
      if (!r.ok) throw Error("Could not load measurement history");
      const history = await r.json();
      if (request !== generation.current || activeBrand.current !== scope) return;
      setPanels(rows[0]?.items || []);
      setSources(rows[1]?.items || []);
      setOpportunities(rows[2]?.items || []);
      setPublications(rows[3]?.items || []);
      setTechnical(rows[4]?.items || []);
      const p = (rows[0]?.items || []).find((p) => p.artifact_key === "default");
      setPersona(p?.payload.persona || "");
      setQuestions((p?.payload.prompts || []).map((p) => p.text).join("\n"));
      setCountry(p?.payload.context?.country || "in");
      setLanguage(p?.payload.context?.language || "en");
      setHistory(history);
      setLoadedBrand(scope);
      setError("");
      setLoaded(true);
    } catch (e) {
      if (request === generation.current && activeBrand.current === scope) setError(e.message);
    }
  }, [call, brandKey]);

  useEffect(() => {
    setError(""); setMessage(""); setBusy(false);
    if (brandKey) load();
    return () => { generation.current++; };
  }, [brandKey, load]);

  async function action(fn) {
    const scope = brandKey;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
      if (activeBrand.current === scope) await load();
    } catch (e) {
      if (activeBrand.current === scope) setError(e.message);
    } finally {
      if (activeBrand.current === scope) setBusy(false);
    }
  }

  const ready = loaded && loadedBrand === brandKey;
  const notice = (value) => { if (activeBrand.current === brandKey) setMessage(value); };
  const panel = panels.find((p) => p.artifact_key === "default");
  const questionCurationOn = Boolean(features?.question_curation);

  function savePanel(state) {
    return action(async () => {
      await call("panel", {
        key: "default",
        expected_version: panel?.version || 0,
        state,
        payload: {
          persona,
          context: {
            country,
            language,
            device: "desktop",
            session_policy: "fresh_anonymous",
          },
          prompts: questions
            .split("\n")
            .filter((q) => q.trim())
            .map((text) => ({ text, origin: "manual", weight: 1 })),
        },
      });
      notice(
        state === "approved"
          ? "Panel approved. Future scans freeze this version."
          : "Panel saved for review.",
      );
    });
  }

  const promptCount = questions.split("\n").filter((q) => q.trim()).length;
  const panelState = !panel ? "No panel" : panel.state === "approved" ? "Approved" : panel.state === "draft" ? "Draft" : panel.state;
  const panelTone = !panel ? "neutral" : panel.state === "approved" ? "good" : "warn";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Questions and evidence"
        description={`Review the questions and audience before measuring ${brand?.display_name || "your brand"}. Generated questions are hypotheses about your audience; search queries describe Google Search, not AI demand.`}
      />

      {error ? (
        <Banner
          tone="error"
          title="Workflow error"
          action={<Button variant="secondary" size="sm" onClick={load}>Retry</Button>}
        >
          {error}
        </Banner>
      ) : null}

      {message ? (
        <Banner tone="info">{message}</Banner>
      ) : null}

      {!ready && !error ? (
        <div className="space-y-4">
          <Card title="Question panel">
            <div className="space-y-3 p-4">
              <Skeleton width="40%" height={16} />
              <Skeleton width="100%" height={120} />
            </div>
          </Card>
        </div>
      ) : null}

      {ready ? (
        <div className="space-y-6">
          {questionCurationOn ? (
            <QuestionsWorkspace />
          ) : (
            <Card
              title="Question panel"
              description={
                panel
                  ? `Version ${panel.version} · Each question has equal weight; branded questions remain diagnostics.`
                  : "No reviewed panel yet. Each question has equal weight; branded questions remain diagnostics."
              }
              actions={
                <div className="flex items-center gap-2">
                  {panel ? <span className="text-xs font-mono text-muted-foreground">v{panel.version}</span> : null}
                  <Badge tone={panelTone}>{panelState}</Badge>
                </div>
              }
            >
              <div className="space-y-4 p-4">
                <label className="block space-y-1.5 text-sm font-medium text-foreground">
                  <span>Audience / persona</span>
                  <input
                    aria-label="Audience / persona"
                    className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    value={persona}
                    onChange={(e) => setPersona(e.target.value)}
                  />
                </label>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <label className="block space-y-1.5 text-sm font-medium text-foreground">
                    <span>Country</span>
                    <input
                      aria-label="Country"
                      maxLength={2}
                      className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      value={country}
                      onChange={(e) => setCountry(e.target.value)}
                    />
                  </label>
                  <label className="block space-y-1.5 text-sm font-medium text-foreground">
                    <span>Language</span>
                    <input
                      aria-label="Language"
                      className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      value={language}
                      onChange={(e) => setLanguage(e.target.value)}
                    />
                  </label>
                </div>

                <div className="space-y-1.5">
                  <label className="block text-sm font-medium text-foreground" htmlFor="measurement-questions">
                    Questions, one per line
                  </label>
                  <textarea
                    id="measurement-questions"
                    aria-label="Questions, one per line"
                    rows={14}
                    className="w-full rounded-lg border border-input bg-background px-3 py-2 text-base md:text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    value={questions}
                    onChange={(e) => setQuestions(e.target.value)}
                  />
                  <p className="text-sm text-muted-foreground">{promptCount} questions</p>
                </div>

                <div className="flex flex-wrap items-center gap-3 pt-2">
                  <Button
                    variant="secondary"
                    disabled={busy || !questions.trim()}
                    onClick={() => savePanel("draft")}
                  >
                    Save for review
                  </Button>
                  <Button
                    disabled={busy || !persona.trim() || !questions.trim()}
                    onClick={() => savePanel("approved")}
                  >
                    Approve this panel
                  </Button>
                  {panel?.state === "approved" && scan?.start ? (
                    <Button
                      variant="outline"
                      onClick={scan.start}
                      disabled={Boolean(scan?.starting || scan?.active)}
                    >
                      Run scan
                    </Button>
                  ) : null}
                </div>
              </div>
            </Card>
          )}

          <Card
            title="Website technical evidence"
            description="Checks up to six owned-page requests. Search indexing and AI inclusion remain separate facts. For a full crawl with AI-crawler checks, open Site Audit."
          >
            <div className="space-y-4 p-4">
              <div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    action(() =>
                      call("technical_audit", { key: crypto.randomUUID() }),
                    )
                  }
                >
                  Check owned website
                </Button>
              </div>
              <div className="space-y-3">
                {technical.map((a) => (
                  <details key={a.id} className="rounded-lg border border-border px-4 py-3 text-sm">
                    <summary className="cursor-pointer font-medium text-foreground">
                      {a.payload.captured_at} · {a.payload.pages.length} pages observed
                    </summary>
                    <div className="mt-3 space-y-3 border-t border-border pt-3">
                      {a.payload.pages.map((p) => (
                        <article key={p.url} className="space-y-1">
                          <h4 className="font-medium text-foreground">{p.final_url}</h4>
                          <p className="text-muted-foreground">
                            HTTP {p.status} · {p.source_text_chars} source characters · Indexing unknown · Rendered content unmeasured
                          </p>
                          {p.issues.map((i, k) => (
                            <p key={k} className="text-xs text-muted-foreground">
                              {i.code}: {i.action}. Owner: {i.owner}. Retest: {i.retest}
                            </p>
                          ))}
                        </article>
                      ))}
                      <p className="text-muted-foreground">{a.payload.interpretation}</p>
                    </div>
                  </details>
                ))}
              </div>
            </div>
          </Card>

          <Card
            title="Source evidence"
            description="Captured web pages providing verified backing passages."
          >
            <div className="space-y-4 p-4">
              <label className="block space-y-1.5 text-sm font-medium text-foreground">
                <span>Source page URL</span>
                <input
                  type="url"
                  aria-label="Source page URL"
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
              </label>
              <div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy || !url}
                  onClick={() =>
                    action(async () => {
                      await call("source_snapshot", {
                        key: crypto.randomUUID(),
                        url,
                      });
                      setMessage(
                        "Source captured. Verify the passage before accepting work.",
                      );
                    })
                  }
                >
                  Capture source
                </Button>
              </div>
              <div className="space-y-3">
                {sources.map((s) => (
                  <details key={s.id} className="rounded-lg border border-border px-4 py-3 text-sm">
                    <summary className="cursor-pointer font-medium text-foreground">
                      {s.payload.final_url} · {s.payload.captured_at}
                    </summary>
                    <div className="mt-3 space-y-2 border-t border-border pt-3">
                      <p className="whitespace-pre-wrap font-mono text-xs text-muted-foreground">
                        {s.payload.text.slice(0, 15000)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Snapshot {s.sha256}. Retrieval by an AI service is unknown.
                      </p>
                    </div>
                  </details>
                ))}
              </div>
            </div>
          </Card>

          <Card
            title="Propose evidence-backed work"
            description="Link observed gaps to specific content modifications."
          >
            <div className="space-y-4 p-4">
              <label className="block space-y-1.5 text-sm font-medium text-foreground">
                <span>Captured source</span>
                <select
                  aria-label="Captured source"
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={sourceId}
                  onChange={(e) => setSourceId(e.target.value)}
                >
                  <option value="">Select a source</option>
                  {sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.payload.final_url}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block space-y-1.5 text-sm font-medium text-foreground">
                <span>Exact supporting passage</span>
                <textarea
                  aria-label="Exact supporting passage"
                  rows={3}
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={passage}
                  onChange={(e) => setPassage(e.target.value)}
                />
              </label>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <label className="block space-y-1.5 text-sm font-medium text-foreground">
                  <span>Target page URL</span>
                  <input
                    aria-label="Target page URL"
                    className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                  />
                </label>
                <label className="block space-y-1.5 text-sm font-medium text-foreground">
                  <span>Owner</span>
                  <input
                    aria-label="Owner"
                    className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    value={owner}
                    onChange={(e) => setOwner(e.target.value)}
                  />
                </label>
              </div>

              <label className="block space-y-1.5 text-sm font-medium text-foreground">
                <span>Proposed change and mechanism</span>
                <textarea
                  aria-label="Proposed change and mechanism"
                  rows={3}
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={mechanism}
                  onChange={(e) => setMechanism(e.target.value)}
                />
              </label>

              <div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy || !sourceId || !passage || !target || !owner || !mechanism}
                  onClick={() =>
                    action(async () => {
                      await call("opportunity", {
                        key: crypto.randomUUID(),
                        source_id: sourceId,
                        passage,
                        target_url: target,
                        owner,
                        mechanism,
                      });
                      setMessage(
                        "Opportunity recorded for human review. No outreach was sent.",
                      );
                    })
                  }
                >
                  Propose work
                </Button>
              </div>

              <div className="space-y-3">
                {opportunities.map((o) => (
                  <article key={o.id} className="rounded-lg border border-border p-4 text-sm space-y-2">
                    <h4 className="font-medium text-foreground">{o.payload.target_url}</h4>
                    <p className="text-muted-foreground">{o.payload.mechanism}</p>
                    <p className="text-xs text-muted-foreground">
                      {o.payload.evidence_status} · {o.payload.decision} · {o.payload.score.repeat_observations} observed captures
                    </p>
                    <blockquote className="border-l-2 border-border pl-3 text-xs italic text-muted-foreground">
                      {o.payload.support.quote || "No verified supporting passage"}
                    </blockquote>
                    {o.state === "unreviewed" ? (
                      <div className="flex items-center gap-2 pt-1">
                        {["accepted", "dismissed"].map((decision) => (
                          <Button
                            key={decision}
                            size="sm"
                            variant={decision === "accepted" ? "default" : "secondary"}
                            disabled={busy || (decision === "accepted" && o.payload.evidence_status !== "verified")}
                            onClick={() => {
                              const reason = window.prompt("Review rationale");
                              if (reason) {
                                action(() =>
                                  call("opportunity", {
                                    action: "review",
                                    artifact_id: o.id,
                                    key: o.artifact_key,
                                    expected_version: o.version,
                                    decision,
                                    reason,
                                  }),
                                );
                              }
                            }}
                          >
                            {decision === "accepted" ? "Accept work" : "Dismiss"}
                          </Button>
                        ))}
                      </div>
                    ) : null}
                    <p className="text-xs text-muted-foreground">
                      Expected effect remains a hypothesis until later compatible observations.
                    </p>
                  </article>
                ))}
              </div>
            </div>
          </Card>

          <Card
            title="Collection history"
            description="Requested location remains unverified unless the provider supplies an observed location."
          >
            <div className="space-y-4 p-4">
              <div className="space-y-3">
                {history?.observations?.map((o) => (
                  <details key={o.id} className="rounded-lg border border-border px-4 py-3 text-sm">
                    <summary className="cursor-pointer font-medium text-foreground">
                      {o.engine} · {o.state} · {o.attempt_count} attempts
                      {o.query ? <> · {o.query}</> : null}
                    </summary>
                    <div className="mt-3 space-y-2 border-t border-border pt-3">
                      <p className="text-muted-foreground">
                        {o.reason} · {o.provenance?.method || "Legacy method unknown"} · Requested {o.provenance?.requested_location || "unknown"} · Location {o.provenance?.location_verification || "unknown"}
                      </p>
                      <p className="text-muted-foreground">
                        Requested model: {o.provenance?.requested_model || "unknown"}; returned model: {o.provenance?.returned_model || "unreported"}. Evidence: {o.evidence_state}.
                      </p>
                      {o.captures.map((c) => (
                        <p key={c.index} className="text-xs">
                          {c.state === "stored" ? (
                            <a
                              target="_blank"
                              rel="noreferrer"
                              className="text-primary hover:underline"
                              href={`/api/customer/measurement/evidence?brand_key=${encodeURIComponent(brandKey)}&observation=${encodeURIComponent(o.id)}&attempt=${o.attempt_id}&index=${c.index}`}
                            >
                              Open private response capture {c.index + 1}
                            </a>
                          ) : (
                            c.reason === "redaction_retracted" ? "Capture withdrawn because redaction could not be verified; the measurement is retained." : c.state === "expired" ? "Raw capture expired; the measurement is retained." : c.state === "write_failed" ? "Capture unavailable because it could not be stored safely." : "Capture is not yet available."
                          )}
                        </p>
                      ))}
                    </div>
                  </details>
                ))}
              </div>

              {history?.windows?.length ? (
                <div className="space-y-2 border-t border-border pt-4">
                  <h4 className="text-sm font-medium text-foreground">Scheduled windows</h4>
                  <div className="space-y-2">
                    {history.windows.map((w) => (
                      <div key={w.window_at} className="rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground">
                        {w.window_at}: {w.disposition} {w.reason}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </Card>

          <Card title="Verified publications">
            <div className="p-4">
              {publications.length ? (
                <div className="space-y-2">
                  {publications.map((p) => (
                    <div key={p.id} className="rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground">
                      {p.payload.url} · Verified {p.payload.published_at}. Indexing, crawl and citations require separate observations.
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No verified publications recorded.</p>
              )}
            </div>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
