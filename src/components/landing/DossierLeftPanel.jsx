"use client";

import { Wordmark } from "@/components/perceev/Wordmark";
import { ScanBar } from "./ScanBar";
import { ProbeCounter } from "./ProbeCounter";

const MODULES = [
  { num: "01", label: "The shift", id: "module-01" },
  { num: "02", label: "The answer", id: "module-02" },
  { num: "03", label: "A verdict", id: "module-03" },
  { num: "04", label: "The rivalry", id: "module-04" },
  { num: "05", label: "Begin", id: "module-05" },
];

export const DossierLeftPanel = ({ activeModule, onModuleClick }) => {
  const handleScroll = (id) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    onModuleClick?.(id);
  };

  return (
    <aside
      style={{
        position: "fixed",
        left: 0,
        top: 0,
        width: "42vw",
        minWidth: "420px",
        height: "100vh",
        background: "var(--bg-0)",
        borderRight: "1px solid var(--border-1)",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: "var(--space-11)",
        overflow: "hidden",
        zIndex: 10,
      }}
    >
      {/* Faint ember glow */}
      <div
        style={{
          position: "absolute",
          top: "15%",
          left: "10%",
          width: "60%",
          height: "40%",
          background: "radial-gradient(ellipse, rgba(232,99,44,0.06) 0%, transparent 70%)",
          pointerEvents: "none",
        }}
      />

      <div style={{ position: "relative", zIndex: 1, maxWidth: "480px" }}>
        <Wordmark size="default" style={{ marginBottom: "var(--space-8)", display: "block" }} />

        <h1
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: "var(--type-display-xl)",
            fontWeight: 600,
            letterSpacing: "var(--track-display)",
            color: "var(--text-1)",
            lineHeight: 1.02,
            marginBottom: "var(--space-8)",
          }}
        >
          When AI answers,
          <br />
          does it name{" "}
          <span style={{ color: "var(--accent)" }}>you</span>
          <br />
          — or your rival?
        </h1>

        <div style={{ marginBottom: "var(--space-10)" }}>
          <ScanBar />
          <p
            style={{
              marginTop: "var(--space-3)",
              fontFamily: "var(--font-mono)",
              fontSize: "10px",
              color: "var(--text-3)",
              letterSpacing: "0.06em",
            }}
          >
            Free · No signup · 60s scan
          </p>
        </div>

        <div style={{ marginBottom: "var(--space-9)" }}>
          <ProbeCounter />
        </div>

        {/* Module nav */}
        <nav style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          {MODULES.map((m) => (
            <button
              key={m.id}
              onClick={() => handleScroll(m.id)}
              style={{
                background: "none",
                border: "none",
                display: "flex",
                alignItems: "center",
                gap: "var(--space-4)",
                padding: "var(--space-2) 0",
                cursor: "pointer",
                textAlign: "left",
                opacity: activeModule === m.id ? 1 : 0.4,
                transition: "opacity var(--dur-fast)",
              }}
            >
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "12px",
                  fontWeight: 500,
                  color: "var(--accent)",
                  width: "24px",
                  letterSpacing: "0.05em",
                }}
              >
                {m.num}
              </span>
              <span
                style={{
                  fontFamily: "var(--font-sans)",
                  fontSize: "15px",
                  color: "var(--text-1)",
                }}
              >
                {m.label}
              </span>
            </button>
          ))}
        </nav>
      </div>
    </aside>
  );
};
