"use client";

import { useRouter, usePathname } from "next/navigation";
import { Wordmark } from "./Wordmark";
import { Button } from "./Button";
import {
  LayoutDashboard,
  MessageSquareText,
  Swords,
  Link2,
  Search,
  Bot,
  History,
  Plus,
  PenSquare,
} from "lucide-react";

const NAV_ITEMS = [
  { key: "overview", label: "Overview", icon: LayoutDashboard, testId: "sidebar-overview" },
  { key: "answers", label: "Answers", icon: MessageSquareText, testId: "sidebar-answers" },
  { key: "rivals", label: "Rivals", icon: Swords, testId: "sidebar-rivals" },
  { key: "sources", label: "Sources", icon: Link2, testId: "sidebar-sources" },
  { key: "queries", label: "Queries", icon: Search, testId: "sidebar-queries" },
  { key: "crawlability", label: "Crawlability", icon: Bot, testId: "sidebar-crawlability" },
  { key: "studio", label: "Studio", icon: PenSquare, testId: "sidebar-studio" },
];

export const Sidebar = ({
  brand,
  website,
  view,
  onViewChange,
  history = [],
  onHistoryClick,
  activeScanTimestamp,
  onNewScan,
  studioBadge = 0,
}) => {
  const router = useRouter();
  const pathname = usePathname();

  return (
    <aside
      data-testid="sidebar"
      style={{
        width: "236px",
        minWidth: "236px",
        height: "100vh",
        background: "var(--bg-1)",
        borderRight: "1px solid var(--border-1)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Brand chip */}
      <div
        style={{
          padding: "var(--space-5) var(--space-5) var(--space-4)",
          borderBottom: "1px solid var(--border-1)",
        }}
      >
        <a
          href="/"
          style={{ display: "inline-block" }}
          onClick={(e) => {
            e.preventDefault();
            router.push("/");
          }}
        >
          <Wordmark size="sm" />
        </a>
      </div>

      {/* Current brand indicator */}
      {brand && (
        <div
          style={{
            padding: "var(--space-3) var(--space-5)",
            borderBottom: "1px solid var(--border-1)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <span
              style={{
                width: "6px",
                height: "6px",
                borderRadius: "var(--radius-round)",
                background: "var(--accent)",
                flexShrink: 0,
              }}
            />
            <div style={{ overflow: "hidden" }}>
              <div
                style={{
                  fontFamily: "var(--font-sans)",
                  fontSize: "14px",
                  fontWeight: 600,
                  color: "var(--text-1)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {brand}
              </div>
              {website && (
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "10px",
                    color: "var(--text-3)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    marginTop: "2px",
                  }}
                >
                  {website}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Nav items */}
      <nav
        style={{
          flex: 1,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          padding: "var(--space-2)",
        }}
      >
        <div style={{ flex: 1, overflowY: "auto" }}>
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = view === item.key;
            return (
              <button
                key={item.key}
                data-testid={item.testId}
                onClick={() => onViewChange(item.key)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "10px",
                  width: "100%",
                  padding: "8px 12px",
                  marginBottom: "2px",
                  borderRadius: "var(--radius-1)",
                  background: isActive ? "var(--bg-2)" : "transparent",
                  border: "none",
                  color: isActive ? "var(--text-1)" : "var(--text-2)",
                  fontFamily: "var(--font-sans)",
                  fontSize: "13px",
                  fontWeight: isActive ? 500 : 400,
                  cursor: "pointer",
                  textAlign: "left",
                  transition: "all var(--dur-fast) var(--ease-out)",
                }}
                onMouseEnter={(e) => {
                  if (!isActive) e.target.style.color = "var(--text-1)";
                }}
                onMouseLeave={(e) => {
                  if (!isActive) e.target.style.color = "var(--text-2)";
                }}
              >
                <Icon size={16} strokeWidth={1.5} />
                {item.label}
                {item.key === "studio" && studioBadge > 0 && (
                  <span
                    data-testid="sidebar-studio-badge"
                    style={{
                      marginLeft: "auto",
                      fontFamily: "var(--font-mono)",
                      fontSize: "9px",
                      fontWeight: 600,
                      minWidth: "18px",
                      height: "18px",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      padding: "0 5px",
                      borderRadius: "var(--radius-round)",
                      background: "var(--accent)",
                      color: "var(--accent-fg)",
                    }}
                  >
                    {studioBadge}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Scan history */}
        {history && history.length > 0 && (
          <div
            style={{
              borderTop: "1px solid var(--border-1)",
              paddingTop: "var(--space-3)",
              marginTop: "var(--space-2)",
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "0 12px var(--space-2)",
              }}
            >
              <History size={12} style={{ color: "var(--text-3)" }} />
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "9px",
                  fontWeight: 500,
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  color: "var(--text-3)",
                }}
              >
                Scan history
              </span>
            </div>
            <div
              style={{
                overflowY: "auto",
                maxHeight: "140px",
                padding: "0 var(--space-2)",
              }}
            >
              {history.slice(0, 5).map((scan, i) => {
                const isActive =
                  activeScanTimestamp &&
                  new Date(scan.scanned_at).getTime() ===
                    new Date(activeScanTimestamp).getTime();
                return (
                  <button
                    key={i}
                    onClick={() => onHistoryClick?.(scan)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      width: "100%",
                      padding: "6px 10px",
                      marginBottom: "2px",
                      borderRadius: "var(--radius-1)",
                      background: isActive ? "var(--bg-2)" : "transparent",
                      border: "none",
                      color: isActive ? "var(--text-1)" : "var(--text-2)",
                      fontFamily: "var(--font-mono)",
                      fontSize: "10px",
                      cursor: "pointer",
                      textAlign: "left",
                      transition: "all var(--dur-fast)",
                    }}
                  >
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {new Date(scan.scanned_at).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                    <span
                      style={{
                        fontFamily: "var(--font-sans)",
                        fontWeight: 600,
                        color: "var(--accent-text)",
                        flexShrink: 0,
                        marginLeft: "8px",
                      }}
                    >
                      {scan.visibility_pct}%
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </nav>

      {/* CTA */}
      <div
        style={{
          padding: "var(--space-4) var(--space-5)",
          borderTop: "1px solid var(--border-1)",
        }}
      >
        <Button
          variant="primary"
          size="md"
          style={{ width: "100%" }}
          onClick={onNewScan || (() => router.push("/scan"))}
        >
          <Plus size={14} />
          New scan
        </Button>
      </div>
    </aside>
  );
};
