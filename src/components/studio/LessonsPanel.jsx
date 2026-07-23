"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Card } from "@/components/perceev/Card";
import { Badge } from "@/components/perceev/Badge";

/** Lessons per brand+playbook with an active toggle. */
export function LessonsPanel({ brand }) {
  const [lessons, setLessons] = useState(null);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/lessons?brand=${encodeURIComponent(brand || "")}&all=1`,
        { cache: "no-store" }
      );
      if (!res.ok) throw new Error((await res.json()).detail || "Failed to load lessons");
      const data = await res.json();
      setLessons(data.lessons || []);
    } catch (e) {
      setError(e.message);
      setLessons([]);
    }
  }, [brand]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const toggle = async (lesson) => {
    // Optimistic flip
    setLessons((prev) =>
      prev.map((l) => (l.id === lesson.id ? { ...l, active: !l.active } : l))
    );
    try {
      await fetch("/api/lessons", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: lesson.id, active: !lesson.active }),
      });
    } catch {
      refresh();
    }
  };

  if (lessons === null) {
    return (
      <div style={{ padding: "var(--space-7)", textAlign: "center" }}>
        <Loader2 size={18} style={{ color: "var(--text-3)", animation: "spin 1s linear infinite" }} />
      </div>
    );
  }

  const byPlaybook = {
    geo_article: lessons.filter((l) => l.playbook === "geo_article"),
    linkedin_post: lessons.filter((l) => l.playbook === "linkedin_post"),
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }} data-testid="studio-lessons">
      {error && <div style={{ fontSize: "12px", color: "var(--crit)" }}>{error}</div>}
      {lessons.length === 0 && (
        <Card style={{ padding: "var(--space-7)", textAlign: "center" }}>
          <p style={{ fontSize: "13px", color: "var(--text-3)" }}>
            No lessons yet. Leave comments when you approve, request changes, or reject —
            each one gets distilled into rules future drafts must follow.
          </p>
        </Card>
      )}
      {Object.entries(byPlaybook).map(([playbook, list]) =>
        list.length === 0 ? null : (
          <Card key={playbook} style={{ padding: "var(--space-5)" }}>
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "10px",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                color: "var(--text-2)",
                marginBottom: "var(--space-4)",
              }}
            >
              {playbook === "geo_article" ? "GEO articles" : "LinkedIn posts"} ({list.length})
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
              {list.map((lesson) => (
                <div
                  key={lesson.id}
                  data-testid="studio-lesson-row"
                  style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-3)" }}
                >
                  <button
                    onClick={() => toggle(lesson)}
                    title={lesson.active ? "Deactivate" : "Activate"}
                    style={{
                      flexShrink: 0,
                      width: "34px",
                      height: "18px",
                      borderRadius: "9px",
                      border: "1px solid var(--border-2)",
                      background: lesson.active ? "var(--accent)" : "var(--bg-2)",
                      position: "relative",
                      cursor: "pointer",
                      transition: "background var(--dur-fast)",
                      marginTop: "2px",
                    }}
                  >
                    <span
                      style={{
                        position: "absolute",
                        top: "2px",
                        left: lesson.active ? "17px" : "2px",
                        width: "12px",
                        height: "12px",
                        borderRadius: "50%",
                        background: lesson.active ? "var(--accent-fg)" : "var(--text-3)",
                        transition: "left var(--dur-fast)",
                      }}
                    />
                  </button>
                  <span
                    style={{
                      fontSize: "13px",
                      lineHeight: 1.5,
                      color: lesson.active ? "var(--text-1)" : "var(--text-3)",
                      textDecoration: lesson.active ? "none" : "line-through",
                    }}
                  >
                    {lesson.lesson}
                  </span>
                  <Badge variant="muted" className="ml-auto">
                    {new Date(lesson.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  </Badge>
                </div>
              ))}
            </div>
          </Card>
        )
      )}
    </div>
  );
}
