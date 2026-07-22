import { useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink, CheckCircle2, XCircle, Link2, AlertCircle } from "lucide-react";
import { Card } from "@/components/perceev/Card";
import { Badge } from "@/components/perceev/Badge";

function highlightBrand(text, aliases) {
  if (!text || !aliases?.length) return text;
  const sorted = [...aliases].sort((a, b) => b.length - a.length);
  const escaped = sorted.map((a) => a.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&"));
  const re = new RegExp(`(^|[^\\w])(${escaped.join("|")})(?=$|[^\\w])`, "gi");
  const parts = [];
  let lastIndex = 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    parts.push(text.slice(lastIndex, match.index + match[1].length));
    parts.push(
      <mark
        key={match.index}
        style={{
          background: "var(--accent-soft)",
          color: "var(--accent-text)",
          fontWeight: 600,
          padding: "0 2px",
          borderRadius: "2px",
        }}
      >
        {match[2]}
      </mark>
    );
    lastIndex = match.index + match[0].length;
  }
  parts.push(text.slice(lastIndex));
  return parts;
}

function StatusPill({ visible, aioPresent, error, isBranded, engine }) {
  // "AI Overview" is Google-specific wording — ChatGPT/Perplexity rows must
  // never be labeled with it. They always answer unless the API errored.
  const noAnswerLabel = engine && engine !== "aio" ? "No answer" : "No AI Overview";
  if (error) {
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "4px",
          padding: "2px 6px",
          borderRadius: "var(--radius-1)",
          background: "var(--crit-bg)",
          color: "var(--crit)",
          fontSize: "10px",
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        <AlertCircle size={12} /> Error
      </span>
    );
  }
  if (!aioPresent) {
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "4px",
          padding: "2px 6px",
          borderRadius: "var(--radius-1)",
          background: "var(--bg-2)",
          color: "var(--text-2)",
          fontSize: "10px",
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        {noAnswerLabel}
      </span>
    );
  }
  if (visible) {
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "4px",
          padding: "2px 6px",
          borderRadius: "var(--radius-1)",
          background: "var(--good-bg)",
          color: "var(--good)",
          fontSize: "10px",
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        <CheckCircle2 size={12} /> Visible{isBranded && " (branded)"}
      </span>
    );
  }
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        padding: "2px 6px",
        borderRadius: "var(--radius-1)",
        background: "var(--crit-bg)",
        color: "var(--crit)",
        fontSize: "10px",
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.08em",
      }}
    >
      <XCircle size={12} /> Absent
    </span>
  );
}

const AioEvidenceRow = ({ prompt, brandAliases }) => {
  const [expanded, setExpanded] = useState(false);
  const {
    prompt: query,
    aioPresent,
    aioText,
    aioReferences,
    brandMentioned,
    brandCited,
    visible,
    competitorsFound,
    competitorsCited,
    isBrandedQuery,
    source,
    error,
    engine,
  } = prompt;

  const hasContent = aioPresent || error;

  const engineLabel = (() => {
    if (engine === "aio") return "AIO";
    if (engine === "chatgpt") return "ChatGPT";
    if (engine === "perplexity") return "PPLX";
    return null;
  })();

  return (
    <div
      data-testid="aio-evidence-row"
      style={{
        borderBottom: "1px solid var(--border-1)",
        background: isBrandedQuery ? "var(--accent-soft)" : "transparent",
      }}
      className="last:border-0"
    >
      <button
        onClick={() => hasContent && setExpanded((v) => !v)}
        style={{
          width: "100%",
          textAlign: "left",
          padding: "var(--space-4) var(--space-6)",
          display: "flex",
          alignItems: "flex-start",
          gap: "var(--space-3)",
          background: "none",
          border: "none",
          cursor: hasContent ? "pointer" : "default",
          color: "inherit",
          fontFamily: "inherit",
        }}
        onMouseEnter={(e) => hasContent && (e.currentTarget.style.background = "var(--bg-2)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = isBrandedQuery ? "var(--accent-soft)" : "transparent")}
      >
        <div style={{ marginTop: "2px", flexShrink: 0 }}>
          {hasContent ? (
            expanded ? (
              <ChevronDown size={16} style={{ color: "var(--text-2)" }} />
            ) : (
              <ChevronRight size={16} style={{ color: "var(--text-2)" }} />
            )
          ) : (
            <span style={{ width: 16, height: 16, display: "inline-block" }} />
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: "14px",
              color: "var(--text-1)",
              fontWeight: 500,
              wordBreak: "break-word",
            }}
          >
            {query}
          </div>
          <div
            style={{
              marginTop: "6px",
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "6px",
            }}
          >
            <StatusPill visible={visible} aioPresent={aioPresent} error={error} isBranded={isBrandedQuery} engine={engine} />
            {engineLabel && (
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "8px",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  padding: "1px 5px",
                  borderRadius: "var(--radius-1)",
                  background: "var(--bg-2)",
                  color: "var(--text-2)",
                  border: "1px solid var(--border-2)",
                }}
              >
                {engineLabel}
              </span>
            )}
            {isBrandedQuery && (
              <Badge variant="accent">Branded query</Badge>
            )}
            {brandMentioned && (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "4px",
                  padding: "2px 6px",
                  borderRadius: "var(--radius-1)",
                  background: "var(--good-bg)",
                  color: "var(--good)",
                  fontSize: "10px",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                }}
              >
                Mentioned in text
              </span>
            )}
            {brandCited && (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "4px",
                  padding: "2px 6px",
                  borderRadius: "var(--radius-1)",
                  background: "var(--info-bg)",
                  color: "var(--info)",
                  fontSize: "10px",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                }}
              >
                Domain cited
              </span>
            )}
            {competitorsFound?.length > 0 && (
              <span
                style={{
                  fontSize: "10px",
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  color: "var(--crit)",
                  fontWeight: 600,
                }}
              >
                Competitors: {competitorsFound.join(", ")}
              </span>
            )}
            {source && (
              <span
                style={{
                  fontSize: "10px",
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  color: "var(--text-3)",
                }}
              >
                {source.replace(/_/g, " ")}
              </span>
            )}
          </div>
        </div>
      </button>

      {expanded && hasContent && (
        <div style={{ padding: "var(--space-2) 14px var(--space-6)", display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          {error ? (
            <div
              style={{
                fontSize: "12px",
                color: "var(--crit)",
                background: "var(--crit-bg)",
                border: "1px solid var(--crit-border)",
                padding: "var(--space-3)",
                borderRadius: "var(--radius-1)",
              }}
            >
              {engineLabel ? `${engineLabel}: ${error}` : `Bright Data returned an error for this query: ${error}`}
            </div>
          ) : (
            <>
              <div>
                <h5
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "9px",
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.1em",
                    color: "var(--text-3)",
                    marginBottom: "var(--space-2)",
                  }}
                >
                  {engineLabel ? `${engineLabel}` : "Google AI Overview"}
                </h5>
                <div
                  style={{
                    fontSize: "13px",
                    color: "var(--text-1)",
                    lineHeight: 1.6,
                    whiteSpace: "pre-line",
                    background: "var(--bg-0)",
                    border: "1px solid var(--border-1)",
                    padding: "var(--space-4)",
                    borderRadius: "var(--radius-1)",
                  }}
                >
                  {highlightBrand(aioText, brandAliases)}
                </div>
              </div>
              {aioReferences?.length > 0 && (
                <div>
                  <h5
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "9px",
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: "0.1em",
                      color: "var(--text-3)",
                      marginBottom: "var(--space-2)",
                      display: "flex",
                      alignItems: "center",
                      gap: "4px",
                    }}
                  >
                    <Link2 size={12} /> Citations ({aioReferences.length})
                  </h5>
                  <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "6px" }}>
                    {aioReferences.map((ref, i) => (
                      <li key={i} style={{ fontSize: "12px" }}>
                        <a
                          href={ref.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "6px",
                            color: "var(--info)",
                          }}
                        >
                          <ExternalLink size={12} />
                          <span style={{ fontWeight: 500 }}>{ref.source || ref.domain || "source"}</span>
                          {ref.title && (
                            <span style={{ color: "var(--text-3)" }}> — {ref.title}</span>
                          )}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {competitorsCited?.length > 0 && (
                <div style={{ fontSize: "12px", color: "var(--crit)" }}>
                  <strong>Competitor domains cited:</strong> {competitorsCited.join(", ")}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};

export const AnswersView = ({ prompts = [], brandAliases = [], title = "Non-branded queries", subtitle, testId, emptyLabel = "No queries yet.", hasBrandedData }) => {
  const [filter, setFilter] = useState("all");
  const [engineFilter, setEngineFilter] = useState("all");

  const hasEngines = prompts.some((p) => p.engine);

  const filtered = prompts.filter((p) => {
    if (engineFilter !== "all") {
      const pEngine = p.engine || "aio";
      if (pEngine !== engineFilter) return false;
    }
    if (filter === "visible") return p.visible;
    if (filter === "absent") return !!(p.aioPresent) && !p.visible;
    if (filter === "no-aio") return !p.aioPresent && !p.error;
    if (filter === "cited") return !!p.brandCited;
    return true;
  });

  const filterChips = [
    { key: "all", label: "All", count: prompts.length },
    { key: "visible", label: "Visible", count: prompts.filter((p) => p.visible).length },
    { key: "absent", label: "Absent", count: prompts.filter((p) => !!(p.aioPresent) && !p.visible).length },
    { key: "no-aio", label: hasEngines ? "No answer" : "No AIO", count: prompts.filter((p) => !p.aioPresent && !p.error).length },
    { key: "cited", label: "Cited", count: prompts.filter((p) => !!p.brandCited).length },
  ];

  const engineChips = hasEngines ? [
    { key: "all", label: "All", count: prompts.length },
    { key: "aio", label: "AIO", count: prompts.filter((p) => (p.engine || "aio") === "aio").length },
    { key: "chatgpt", label: "ChatGPT", count: prompts.filter((p) => p.engine === "chatgpt").length },
    { key: "perplexity", label: "PPLX", count: prompts.filter((p) => p.engine === "perplexity").length },
  ].filter((c) => c.key === "all" || c.count > 0) : null;

  return (
    <div style={{ display: "flex", gap: "var(--space-6)", height: "100%", overflow: "hidden" }}>
      {/* Left: query list */}
      <div style={{ flex: "1 1 60%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <Card variant="flush" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div
            style={{
              padding: "var(--space-5) var(--space-6)",
              borderBottom: "1px solid var(--border-1)",
            }}
          >
            <h3
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: "var(--type-h3)",
                fontWeight: 600,
                color: "var(--text-1)",
                letterSpacing: "var(--track-h3)",
              }}
            >
              {title}
            </h3>
            {subtitle && (
              <p style={{ fontSize: "13px", color: "var(--text-2)", marginTop: "4px" }}>{subtitle}</p>
            )}
            <div
              style={{
                display: "flex",
                gap: "var(--space-2)",
                marginTop: "var(--space-4)",
                flexWrap: "wrap",
              }}
            >
              {filterChips.map((chip) => (
                <button
                  key={chip.key}
                  onClick={() => setFilter(chip.key)}
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "10px",
                    fontWeight: 500,
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    padding: "4px 10px",
                    borderRadius: "var(--radius-round)",
                    background: filter === chip.key ? "var(--accent-soft)" : "var(--bg-2)",
                    color: filter === chip.key ? "var(--accent-text)" : "var(--text-2)",
                    border: "none",
                    cursor: "pointer",
                    transition: "all var(--dur-fast)",
                  }}
                >
                  {chip.label} <span style={{ opacity: 0.6 }}>{chip.count}</span>
                </button>
              ))}
            </div>
            {engineChips && (
              <div
                style={{
                  display: "flex",
                  gap: "var(--space-2)",
                  marginTop: "var(--space-3)",
                  flexWrap: "wrap",
                }}
              >
                {engineChips.map((chip) => (
                  <button
                    key={chip.key}
                    onClick={() => setEngineFilter(chip.key)}
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "9px",
                      fontWeight: 500,
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      padding: "3px 8px",
                      borderRadius: "var(--radius-round)",
                      background: engineFilter === chip.key ? "var(--info-bg)" : "var(--bg-2)",
                      color: engineFilter === chip.key ? "var(--info)" : "var(--text-3)",
                      border: engineFilter === chip.key ? "1px solid var(--info-border)" : "1px solid var(--border-2)",
                      cursor: "pointer",
                      transition: "all var(--dur-fast)",
                    }}
                  >
                    {chip.label} <span style={{ opacity: 0.6 }}>{chip.count}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div style={{ flex: 1, overflowY: "auto" }}>
            {filtered.length === 0 ? (
              <div style={{ padding: "var(--space-10)", textAlign: "center", fontSize: "13px", color: "var(--text-3)" }}>
                {emptyLabel}
              </div>
            ) : (
              filtered.map((p, i) => (
                <AioEvidenceRow key={i} prompt={p} brandAliases={brandAliases} />
              ))
            )}
          </div>
        </Card>
      </div>
    </div>
  );
};
