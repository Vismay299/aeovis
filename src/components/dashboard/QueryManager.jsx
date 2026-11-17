import React, { useState, useEffect } from "react";
import { Plus, CheckCircle2, AlertCircle, Sparkles } from "lucide-react";
import { normalizeTopic } from "@/shared/scoring/topics";

const INTENT_LABELS = {
  high_intent: "High Intent",
  comparison: "Comparison",
  problem_aware: "Problem Aware",
  exploratory: "Exploratory",
  branded: "Branded"
};

export const QueryManager = ({ brand, legacyBrand, currentPrompts = [], onPromptAdded }) => {
  const [prompts, setPrompts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newText, setNewText] = useState("");
  const [newIntent, setNewIntent] = useState("high_intent");
  const [newTopic, setNewTopic] = useState("General");
  const [actionLoading, setActionLoading] = useState(false);
  const [message, setMessage] = useState(null);

  // `brand` is the canonical pool key (domain-first, see resolveBrandKey).
  // `legacyBrand` lets the API fall back to pre-migration pools stored under
  // the typed brand name, so the tab isn't empty before the next scan.
  const listUrl = () => {
    const params = new URLSearchParams({ includeDisabled: "true" });
    if (legacyBrand && legacyBrand !== brand) params.set("legacyBrand", legacyBrand);
    return `/api/brands/${encodeURIComponent(brand)}/prompts?${params.toString()}`;
  };

  useEffect(() => {
    async function fetchPrompts() {
      try {
        const res = await fetch(listUrl());
        if (res.ok) {
          const data = await res.json();
          setPrompts(data.prompts || []);
        }
      } catch (e) {
        console.error("Failed to load prompts:", e);
      } finally {
        setLoading(false);
      }
    }
    fetchPrompts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brand, legacyBrand]);

  const displayPrompts = prompts.length > 0 ? prompts : currentPrompts.map((p, idx) => ({
    id: p.id || `temp-${idx}`,
    text: p.prompt,
    intent_tier: p.intentTier,
    topic: p.topic,
    enabled: true
  }));

  const handleAddPrompt = async (e) => {
    e.preventDefault();
    if (!newText.trim()) return;

    setActionLoading(true);
    setMessage(null);

    try {
      const res = await fetch(`/api/brands/${encodeURIComponent(brand)}/prompts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: newText.trim(),
          intent_tier: newIntent,
          topic: newTopic.trim() || "General",
          weight: null
        })
      });

      if (res.ok) {
        setNewText("");
        setNewTopic("General");
        setMessage({ type: "success", text: "Query added successfully! Run a new scan to update your score." });

        const refresh = await fetch(listUrl());
        if (refresh.ok) {
          const refreshData = await refresh.json();
          setPrompts(refreshData.prompts || []);
        }
        if (onPromptAdded) onPromptAdded();
      } else {
        setMessage({ type: "error", text: "Failed to add query. Make sure Supabase is connected." });
      }
    } catch (err) {
      setMessage({ type: "error", text: "Network error occurred." });
    } finally {
      setActionLoading(false);
    }
  };

  const handleTogglePrompt = async (id, promptText, currentStatus) => {
    if (id.toString().startsWith("temp-")) {
      setMessage({ type: "error", text: "Cannot modify static/temporary prompts. Run a scan to persist them first." });
      return;
    }

    setActionLoading(true);
    setMessage(null);

    try {
      const res = await fetch(`/api/prompts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !currentStatus })
      });

      if (res.ok) {
        setMessage({
          type: "success",
          text: `Successfully ${!currentStatus ? "enabled" : "disabled"} query: "${promptText.slice(0, 30)}..."`
        });

        const refresh = await fetch(listUrl());
        if (refresh.ok) {
          const refreshData = await refresh.json();
          setPrompts(refreshData.prompts || []);
        }
      } else {
        setMessage({ type: "error", text: "Failed to update query status." });
      }
    } catch (err) {
      setMessage({ type: "error", text: "Network error occurred." });
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: "var(--space-6)", padding: "var(--space-6)" }}>
      {/* Left pane: Add query */}
      <div style={{ alignSelf: "start", position: "sticky", top: "var(--space-6)" }}>
        <div
          style={{
            background: "var(--bg-0)",
            border: "1px solid var(--border-1)",
            borderRadius: "var(--radius-2)",
            padding: "var(--space-6)",
          }}
        >
          <h3
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "16px",
              fontWeight: 600,
              color: "var(--text-1)",
              marginBottom: "var(--space-2)",
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
            }}
          >
            <Sparkles size={16} style={{ color: "var(--brand)" }} />
            Add Custom Query
          </h3>
          <p style={{ fontSize: "12px", color: "var(--text-3)", marginBottom: "var(--space-5)", lineHeight: 1.5 }}>
            Target specific customer questions or keyword variations. Your AEO Visibility score will automatically incorporate these in the next scan.
          </p>

          <form onSubmit={handleAddPrompt} style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
            <div>
              <label
                style={{
                  display: "block",
                  fontFamily: "var(--font-mono)",
                  fontSize: "9px",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  color: "var(--text-2)",
                  marginBottom: "var(--space-2)",
                }}
              >
                Query Text
              </label>
              <textarea
                required
                rows={3}
                value={newText}
                onChange={(e) => setNewText(e.target.value)}
                placeholder="e.g. What is the best CRM software for real estate agencies?"
                style={{
                  width: "100%",
                  background: "var(--bg-1)",
                  border: "1px solid var(--border-2)",
                  borderRadius: "var(--radius-1)",
                  padding: "10px 12px",
                  fontFamily: "var(--font-sans)",
                  fontSize: "13px",
                  color: "var(--text-1)",
                  outline: "none",
                  resize: "none",
                  boxSizing: "border-box",
                }}
                onFocus={(e) => (e.target.style.borderColor = "var(--brand)")}
                onBlur={(e) => (e.target.style.borderColor = "var(--border-2)")}
              />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "var(--space-4)" }}>
              <div>
                <label
                  style={{
                    display: "block",
                    fontFamily: "var(--font-mono)",
                    fontSize: "9px",
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.1em",
                    color: "var(--text-2)",
                    marginBottom: "var(--space-2)",
                  }}
                >
                  Intent Tier
                </label>
                <select
                  value={newIntent}
                  onChange={(e) => setNewIntent(e.target.value)}
                  style={{
                    width: "100%",
                    background: "var(--bg-1)",
                    border: "1px solid var(--border-2)",
                    borderRadius: "var(--radius-1)",
                    padding: "8px 10px",
                    fontFamily: "var(--font-sans)",
                    fontSize: "12px",
                    color: "var(--text-1)",
                    outline: "none",
                    boxSizing: "border-box",
                  }}
                >
                  <option value="high_intent">High Intent</option>
                  <option value="comparison">Comparison</option>
                  <option value="problem_aware">Problem Aware</option>
                  <option value="exploratory">Exploratory</option>
                  <option value="branded">Branded</option>
                </select>
              </div>

              <div>
                <label
                  style={{
                    display: "block",
                    fontFamily: "var(--font-mono)",
                    fontSize: "9px",
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.1em",
                    color: "var(--text-2)",
                    marginBottom: "var(--space-2)",
                  }}
                >
                  Topic / Category
                </label>
                <input
                  type="text"
                  value={newTopic}
                  onChange={(e) => setNewTopic(e.target.value)}
                  placeholder="e.g. Features"
                  style={{
                    width: "100%",
                    background: "var(--bg-1)",
                    border: "1px solid var(--border-2)",
                    borderRadius: "var(--radius-1)",
                    padding: "8px 10px",
                    fontFamily: "var(--font-sans)",
                    fontSize: "12px",
                    color: "var(--text-1)",
                    outline: "none",
                    boxSizing: "border-box",
                  }}
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={actionLoading || !newText.trim()}
              style={{
                width: "100%",
                background: "var(--brand)",
                color: "var(--accent-fg)",
                border: "none",
                borderRadius: "var(--radius-1)",
                padding: "10px 16px",
                fontFamily: "var(--font-mono)",
                fontSize: "10px",
                fontWeight: 500,
                textTransform: "uppercase",
                letterSpacing: "0.12em",
                cursor: actionLoading || !newText.trim() ? "not-allowed" : "pointer",
                opacity: actionLoading || !newText.trim() ? 0.5 : 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "var(--space-2)",
              }}
            >
              <Plus size={14} />
              Add Query
            </button>
          </form>

          {message && (
            <div
              style={{
                marginTop: "var(--space-4)",
                padding: "var(--space-3)",
                borderRadius: "var(--radius-1)",
                fontSize: "12px",
                fontWeight: 500,
                display: "flex",
                alignItems: "flex-start",
                gap: "var(--space-2)",
                background: message.type === "success" ? "var(--good-bg)" : "var(--crit-bg)",
                color: message.type === "success" ? "var(--good)" : "var(--crit)",
              }}
            >
              {message.type === "success" ? (
                <CheckCircle2 size={14} style={{ flexShrink: 0, marginTop: "2px" }} />
              ) : (
                <AlertCircle size={14} style={{ flexShrink: 0, marginTop: "2px" }} />
              )}
              <span>{message.text}</span>
            </div>
          )}
        </div>
      </div>

      {/* Right pane: list */}
      <div
        style={{
          background: "var(--bg-0)",
          border: "1px solid var(--border-1)",
          borderRadius: "var(--radius-2)",
          padding: "var(--space-6)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderBottom: "1px solid var(--border-1)",
            paddingBottom: "var(--space-4)",
            marginBottom: "var(--space-5)",
          }}
        >
          <div>
            <h3
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: "var(--type-h3)",
                fontWeight: 600,
                color: "var(--text-1)",
                letterSpacing: "var(--track-h3)",
              }}
            >
              Currently Tracked Queries
            </h3>
            <p style={{ fontSize: "12px", color: "var(--text-3)", marginTop: "4px" }}>
              Active prompt set for visibility scans.
            </p>
          </div>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "10px",
              fontWeight: 500,
              padding: "4px 10px",
              borderRadius: "var(--radius-round)",
              background: "var(--bg-2)",
              color: "var(--text-1)",
            }}
          >
            {displayPrompts.length} total
          </span>
        </div>

        {loading ? (
          <div style={{ padding: "var(--space-10) 0", textAlign: "center", fontSize: "13px", color: "var(--text-3)" }}>
            Loading tracked queries...
          </div>
        ) : displayPrompts.length === 0 ? (
          <div style={{ padding: "var(--space-10) 0", textAlign: "center", fontSize: "13px", color: "var(--text-3)" }}>
            No tracked queries. Run your first scan to generate them automatically.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", maxHeight: "600px", overflowY: "auto", paddingRight: "var(--space-2)" }}>
            {displayPrompts.map((p) => (
              <div
                key={p.id}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  gap: "var(--space-4)",
                  border: "1px solid var(--border-1)",
                  borderRadius: "var(--radius-2)",
                  padding: "var(--space-4)",
                  background: "var(--bg-1)",
                  opacity: p.enabled ? 1 : 0.5,
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
                  <p
                    style={{
                      fontSize: "13px",
                      fontWeight: 500,
                      lineHeight: 1.5,
                      color: p.enabled ? "var(--text-1)" : "var(--text-3)",
                      textDecoration: p.enabled ? "none" : "line-through",
                    }}
                  >
                    {p.text}
                  </p>
                  <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px" }}>
                    {p.intent_tier && (
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          padding: "2px 6px",
                          borderRadius: "var(--radius-1)",
                          background: "var(--bg-2)",
                          fontSize: "9px",
                          fontWeight: 600,
                          color: "var(--text-1)",
                          textTransform: "uppercase",
                          letterSpacing: "0.08em",
                        }}
                      >
                        {INTENT_LABELS[p.intent_tier] || p.intent_tier.replace("_", " ")}
                      </span>
                    )}
                    {p.topic && (
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          padding: "2px 6px",
                          borderRadius: "var(--radius-1)",
                          background: "var(--accent-soft)",
                          fontSize: "9px",
                          fontWeight: 600,
                          color: "var(--accent-text)",
                          textTransform: "uppercase",
                          letterSpacing: "0.08em",
                        }}
                      >
                        {normalizeTopic(p.topic)}
                      </span>
                    )}
                    {!p.enabled && (
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          padding: "2px 6px",
                          borderRadius: "var(--radius-1)",
                          background: "var(--crit-bg)",
                          fontSize: "9px",
                          fontWeight: 600,
                          color: "var(--crit)",
                          textTransform: "uppercase",
                          letterSpacing: "0.08em",
                        }}
                      >
                        Disabled
                      </span>
                    )}
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexShrink: 0, paddingTop: "2px" }}>
                  <label style={{ position: "relative", display: "inline-flex", alignItems: "center", cursor: "pointer", userSelect: "none" }}>
                    <input
                      type="checkbox"
                      checked={!!p.enabled}
                      disabled={actionLoading}
                      onChange={() => handleTogglePrompt(p.id, p.text, !!p.enabled)}
                      style={{ position: "absolute", opacity: 0, width: 0, height: 0 }}
                    />
                    <div
                      style={{
                        width: "36px",
                        height: "20px",
                        borderRadius: "var(--radius-round)",
                        background: p.enabled ? "var(--good)" : "var(--border-2)",
                        transition: "background var(--dur-fast)",
                        position: "relative",
                      }}
                    >
                      <span
                        style={{
                          position: "absolute",
                          top: "2px",
                          left: p.enabled ? "18px" : "2px",
                          width: "16px",
                          height: "16px",
                          borderRadius: "var(--radius-round)",
                          background: "#fff",
                          transition: "left var(--dur-fast)",
                        }}
                      />
                    </div>
                  </label>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
