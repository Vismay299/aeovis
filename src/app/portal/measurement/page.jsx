"use client";
import { useCallback, useEffect, useState, useRef } from "react";
import { usePortal } from "@/components/portal/PortalShell";
export default function MeasurementPage() {
  const { brandKey, brand, redirectToLogin } = usePortal();
  const activeBrand=useRef(brandKey), generation=useRef(0);
  activeBrand.current=brandKey;
  const [loadedBrand,setLoadedBrand]=useState(null);
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
    const request=++generation.current,scope=brandKey;
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
      const history=await r.json();
      if(request!==generation.current || activeBrand.current!==scope)return;
      setPanels(rows[0].items);
      setSources(rows[1].items);
      setOpportunities(rows[2].items);
      setPublications(rows[3].items);
      setTechnical(rows[4].items);
      const p = rows[0].items.find((p) => p.artifact_key === "default");
      setPersona(p?.payload.persona || "");
      setQuestions((p?.payload.prompts || []).map((p) => p.text).join("\n"));
      setCountry(p?.payload.context?.country || "in");
      setLanguage(p?.payload.context?.language || "en");
      setHistory(history);
      setLoadedBrand(scope);
      setError("");
      setLoaded(true);
    } catch (e) {
      if(request===generation.current && activeBrand.current===scope)setError(e.message);
    }
  }, [call,brandKey]);
  useEffect(() => {
    setError("");setMessage("");setBusy(false);
    if (brandKey) load();
    return ()=>{generation.current++;};
  }, [brandKey, load]);
  async function action(fn) {
    const scope=brandKey;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
      if(activeBrand.current===scope)await load();
    } catch (e) {
      if(activeBrand.current===scope)setError(e.message);
    } finally {
      if(activeBrand.current===scope)setBusy(false);
    }
  }
  const ready=loaded && loadedBrand===brandKey;
  const notice=value=>{if(activeBrand.current===brandKey)setMessage(value);};
  const panel = panels.find((p) => p.artifact_key === "default");
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
  return (
    <main className="pv-page">
      <h1>Questions and evidence</h1>
      <p>
        Review the questions and audience before measuring {brand?.display_name}
        . Generated questions are hypotheses about your audience; search queries
        describe Google Search, not AI demand.
      </p>
      {error ? (
        <p role="alert">
          {error} <button onClick={load}>Retry</button>
        </p>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      {!ready && !error ? (
        <p role="status">Loading workspace evidence…</p>
      ) : null}
      {ready ? (
        <>
          <section className="pv-card" style={{ padding: 24 }}>
            <h2>Question panel</h2>
            <p>
              {panel
                ? `Version ${panel.version} · ${panel.state}`
                : "No reviewed panel yet"}
              . Each question has equal weight; branded questions remain
              diagnostics.
            </p>
            <label>
              Audience / persona
              <input
                aria-label="Audience / persona"
                value={persona}
                onChange={(e) => setPersona(e.target.value)}
              />
            </label>
            <label>
              Country
              <input
                aria-label="Country"
                maxLength={2}
                value={country}
                onChange={(e) => setCountry(e.target.value)}
              />
            </label>
            <label>
              Language
              <input
                aria-label="Language"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
              />
            </label>
            <label>
              Questions, one per line
              <textarea
                aria-label="Questions, one per line"
                rows={12}
                value={questions}
                onChange={(e) => setQuestions(e.target.value)}
                style={{ width: "100%" }}
              />
            </label>
            <button
              disabled={busy || !questions.trim()}
              onClick={() => savePanel("draft")}
            >
              Save for review
            </button>{" "}
            <button
              disabled={busy || !persona.trim() || !questions.trim()}
              onClick={() => savePanel("approved")}
            >
              Approve this panel
            </button>
          </section>
          <section className="pv-card" style={{ padding: 24 }}>
            <h2>Website technical evidence</h2>
            <p>
              Checks up to six owned-page requests. Search indexing and AI
              inclusion remain separate facts.
            </p>
            <button
              disabled={busy}
              onClick={() =>
                action(() =>
                  call("technical_audit", { key: crypto.randomUUID() }),
                )
              }
            >
              Check owned website
            </button>
            {technical.map((a) => (
              <details key={a.id}>
                <summary>
                  {a.payload.captured_at} · {a.payload.pages.length} pages
                  observed
                </summary>
                {a.payload.pages.map((p) => (
                  <article key={p.url}>
                    <h3>{p.final_url}</h3>
                    <p>
                      HTTP {p.status} · {p.source_text_chars} source characters
                      · Indexing unknown · Rendered content unmeasured
                    </p>
                    {p.issues.map((i, k) => (
                      <p key={k}>
                        {i.code}: {i.action}. Owner: {i.owner}. Retest:{" "}
                        {i.retest}
                      </p>
                    ))}
                  </article>
                ))}
                <p>{a.payload.interpretation}</p>
              </details>
            ))}
          </section>
          <section className="pv-card" style={{ padding: 24 }}>
            <h2>Source evidence</h2>
            <label>
              Source page URL
              <input
                type="url"
                aria-label="Source page URL"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </label>
            <button
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
            </button>
            {sources.map((s) => (
              <details key={s.id}>
                <summary>
                  {s.payload.final_url} · {s.payload.captured_at}
                </summary>
                <p style={{ whiteSpace: "pre-wrap" }}>
                  {s.payload.text.slice(0, 15000)}
                </p>
                <p>
                  Snapshot {s.sha256}. Retrieval by an AI service is unknown.
                </p>
              </details>
            ))}
          </section>
          <section className="pv-card" style={{ padding: 24 }}>
            <h2>Propose evidence-backed work</h2>
            <label>
              Captured source
              <select
                aria-label="Captured source"
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
            <label>
              Exact supporting passage
              <textarea
                aria-label="Exact supporting passage"
                value={passage}
                onChange={(e) => setPassage(e.target.value)}
              />
            </label>
            <label>
              Target page URL
              <input
                aria-label="Target page URL"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              />
            </label>
            <label>
              Owner
              <input
                aria-label="Owner"
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
              />
            </label>
            <label>
              Proposed change and mechanism
              <textarea
                aria-label="Proposed change and mechanism"
                value={mechanism}
                onChange={(e) => setMechanism(e.target.value)}
              />
            </label>
            <button
              disabled={
                busy || !sourceId || !passage || !target || !owner || !mechanism
              }
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
            </button>
            {opportunities.map((o) => (
              <article key={o.id}>
                <h3>{o.payload.target_url}</h3>
                <p>{o.payload.mechanism}</p>
                <p>
                  {o.payload.evidence_status} · {o.payload.decision} ·{" "}
                  {o.payload.score.repeat_observations} observed captures
                </p>
                <blockquote>
                  {o.payload.support.quote || "No verified supporting passage"}
                </blockquote>
                {o.state === "unreviewed"
                  ? ["accepted", "dismissed"].map((decision) => (
                      <button
                        key={decision}
                        disabled={
                          busy ||
                          (decision === "accepted" &&
                            o.payload.evidence_status !== "verified")
                        }
                        onClick={() => {
                          const reason = window.prompt("Review rationale");
                          if (reason)
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
                        }}
                      >
                        {decision === "accepted" ? "Accept work" : "Dismiss"}
                      </button>
                    ))
                  : null}
                <p>
                  Expected effect remains a hypothesis until later compatible
                  observations.
                </p>
              </article>
            ))}
          </section>
          <section>
            <h2>Collection history</h2>
            <p>
              Requested location remains unverified unless the provider supplies
              an observed location.
            </p>
            {history?.observations?.map((o) => (
              <details key={o.id}>
                <summary>
                  {o.engine} · {o.state} · {o.attempt_count} attempts
                </summary>
                <p>
                  {o.reason} · {o.provenance?.method || "Legacy method unknown"}{" "}
                  · Requested {o.provenance?.requested_location || "unknown"} ·
                  Location {o.provenance?.location_verification || "unknown"}
                </p>
                <p>
                  Requested model: {o.provenance?.requested_model || "unknown"};
                  returned model: {o.provenance?.returned_model || "unreported"}
                  . Evidence: {o.evidence_state}.
                </p>
                {o.captures.map((c) => (
                  <p key={c.index}>
                    {c.state === "stored" ? (
                      <a
                        target="_blank"
                        rel="noreferrer"
                        href={`/api/customer/measurement/evidence?brand_key=${encodeURIComponent(brandKey)}&observation=${encodeURIComponent(o.id)}&attempt=${o.attempt_id}&index=${c.index}`}
                      >
                        Open private response capture {c.index + 1}
                      </a>
                    ) : (
                      c.state
                    )}
                  </p>
                ))}
              </details>
            ))}
            <h3>Scheduled opportunities</h3>
            {history?.windows?.map((w) => (
              <p key={w.window_at}>
                {w.window_at}: {w.disposition} {w.reason}
              </p>
            ))}
          </section>
          <section>
            <h2>Verified publications</h2>
            {publications.length ? (
              publications.map((p) => (
                <p key={p.id}>
                  {p.payload.url} · Verified {p.payload.published_at}. Indexing,
                  crawl and citations require separate observations.
                </p>
              ))
            ) : (
              <p>No verified publications recorded.</p>
            )}
          </section>
        </>
      ) : null}
    </main>
  );
}
