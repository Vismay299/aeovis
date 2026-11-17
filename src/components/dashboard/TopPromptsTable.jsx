import React, { useState, useMemo } from "react";
import { rankColor } from "@/shared/format";
import { ChevronDown, ChevronRight, Filter } from "lucide-react";
import { normalizeTopic } from "@/shared/scoring/topics";

const INTENT_LABELS = {
  high_intent: "High Intent",
  comparison: "Comparison",
  problem_aware: "Problem Aware",
  exploratory: "Exploratory",
  branded: "Branded"
};

export const TopPromptsTable = ({ prompts }) => {
  const [viewMode, setViewMode] = useState("flat"); // "flat" | "topic"
  const [selectedTopic, setSelectedTopic] = useState("all");
  const [expandedTopics, setExpandedTopics] = useState({});

  // Extract unique topics list for filtering
  const topics = useMemo(() => {
    const list = new Set(prompts.map(p => normalizeTopic(p.topic || "General")));
    return ["all", ...Array.from(list).sort()];
  }, [prompts]);

  // Group prompts by topic
  const groupedPrompts = useMemo(() => {
    const groups = {};
    prompts.forEach(p => {
      const topic = normalizeTopic(p.topic || "General");
      if (!groups[topic]) {
        groups[topic] = [];
      }
      groups[topic].push(p);
    });

    const resultGroups = Object.keys(groups).map(topic => {
      const list = groups[topic];
      const sum = list.reduce((acc, curr) => acc + (curr.promptScore ?? 0), 0);
      const avg = list.length > 0 ? Math.round((sum / list.length) * 10) / 10 : 0.0;
      return {
        topic,
        prompts: list,
        averageScore: avg
      };
    });

    // Filter topics based on selection
    const filteredGroups = selectedTopic === "all"
      ? resultGroups
      : resultGroups.filter(g => g.topic === selectedTopic);

    // Sort topics by average score descending
    return filteredGroups.sort((a, b) => b.averageScore - a.averageScore);
  }, [prompts, selectedTopic]);

  // Filter prompts for flat view
  const filteredPrompts = useMemo(() => {
    if (selectedTopic === "all") return prompts;
    return prompts.filter(p => normalizeTopic(p.topic || "General") === selectedTopic);
  }, [prompts, selectedTopic]);

  const toggleTopic = (topic) => {
    setExpandedTopics(prev => ({
      ...prev,
      [topic]: !prev[topic]
    }));
  };

  const renderPromptCell = (p) => (
    <>
      <div className="font-medium">{p.prompt}</div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {p.intentTier && (
          <span className="inline-flex items-center px-2 py-0.5 rounded-sm bg-[var(--panel-2)] text-[9px] font-semibold text-[var(--text-1)] uppercase tracking-wider">
            🎯 {INTENT_LABELS[p.intentTier] || p.intentTier.replace("_", " ")}
          </span>
        )}
        {p.topic && (
          <span className="inline-flex items-center px-2 py-0.5 rounded-sm bg-[var(--lamp-red-soft)] text-[9px] font-semibold text-[var(--lamp-amber)] uppercase tracking-wider">
            📁 {normalizeTopic(p.topic)}
          </span>
        )}
        {p.brandInPromptWarning && (
          <span className="inline-flex items-center px-2 py-0.5 rounded-sm bg-[var(--lamp-red-soft)] text-[9px] font-bold text-[var(--lamp-red)] uppercase tracking-wider border border-[var(--lamp-red-edge)]" title="Prompt contains the brand name, introducing search bias.">
            ⚠️ Brand In Prompt
          </span>
        )}
        {p.citations && p.citations.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {p.citations.map((c, idx) => {
              let label = c;
              try {
                label = new URL(c).hostname.replace('www.', '');
              } catch(e) {}
              return (
                <a 
                  key={idx} 
                  href={c} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-sm bg-[var(--panel-2)] border border-[var(--rule-1)] text-[10px] text-[var(--text-2)] hover:bg-[var(--rule-1)] hover:text-[var(--text-1)] transition-colors"
                >
                  📎 {label}
                </a>
              );
            })}
          </div>
        )}
      </div>
    </>
  );

  return (
    <div
      data-testid="top-prompts-table"
      className="bg-[var(--panel-1)] border border-[var(--rule-1)] rounded-sm"
    >
      <div className="px-7 py-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[var(--rule-1)]">
        <div>
          <h3 className="font-serif text-2xl font-semibold text-[var(--text-1)] leading-tight">
            Top Prompts
          </h3>
          <p className="text-sm text-[var(--text-2)] mt-1">
            Where your brand surfaces in AI answers
          </p>
        </div>
        
        <div className="flex flex-wrap items-center gap-3">
          {/* Flat List vs Topic Group Toggle */}
          <div className="flex bg-[var(--panel-2)] p-0.5 rounded-sm border border-[var(--rule-1)]">
            <button
              onClick={() => setViewMode("flat")}
              className={`px-3 py-1.5 text-xs font-semibold uppercase tracking-wider rounded-sm transition-colors ${viewMode === "flat" ? "bg-[var(--panel-1)] text-[var(--text-1)] shadow-xs" : "text-[var(--text-2)] hover:text-[var(--text-1)]"}`}
            >
              List
            </button>
            <button
              onClick={() => setViewMode("topic")}
              className={`px-3 py-1.5 text-xs font-semibold uppercase tracking-wider rounded-sm transition-colors ${viewMode === "topic" ? "bg-[var(--panel-1)] text-[var(--text-1)] shadow-xs" : "text-[var(--text-2)] hover:text-[var(--text-1)]"}`}
            >
              Topics
            </button>
          </div>

          {/* Topic Filter Dropdown */}
          {prompts.length > 0 && (
            <div className="relative flex items-center">
              <Filter className="w-3.5 h-3.5 text-[var(--text-2)] absolute left-3 pointer-events-none" />
              <select
                value={selectedTopic}
                onChange={(e) => setSelectedTopic(e.target.value)}
                className="text-xs border border-[var(--rule-1)] pl-8 pr-3 py-2 rounded-sm focus:outline-hidden focus:border-[var(--text-1)] bg-transparent font-semibold uppercase tracking-wider text-[var(--text-2)] appearance-none cursor-pointer"
              >
                <option value="all">All Topics</option>
                {topics.filter(t => t !== "all").map(t => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
          )}

          <span className="text-xs uppercase tracking-[0.15em] text-[var(--text-3)] font-medium self-center">
            {prompts.length} tracked
          </span>
        </div>
      </div>

      {prompts.length === 0 ? (
        <div className="px-7 py-14 text-center text-[var(--text-3)] text-sm" data-testid="top-prompts-empty">
          No prompt data available for this scan.
        </div>
      ) : viewMode === "flat" ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-[var(--text-1)]">
                <th className="text-[11px] uppercase tracking-[0.12em] text-[var(--text-1)] font-semibold px-7 py-3">
                  Prompt
                </th>
                <th className="text-[11px] uppercase tracking-[0.12em] text-[var(--text-1)] font-semibold text-center px-4 py-3 w-24">
                  Score
                </th>
                <th className="text-[11px] uppercase tracking-[0.12em] text-[var(--text-1)] font-semibold text-center px-4 py-3 w-24">
                  Rank
                </th>
                <th className="text-[11px] uppercase tracking-[0.12em] text-[var(--text-1)] font-semibold text-right px-7 py-3 w-28">
                  Volume
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredPrompts.map((p, i) => (
                <tr
                  key={i}
                  data-testid={`prompt-row-${i}`}
                  className="border-b border-[var(--rule-1)] last:border-0 hover:bg-[var(--panel-1)] transition-colors"
                >
                  <td className="px-7 py-5 text-sm text-[var(--text-1)]">
                    {renderPromptCell(p)}
                  </td>
                  <td className="px-4 py-5 text-center font-serif font-bold text-base text-[var(--lamp-amber)]">
                    {p.promptScore != null ? `${p.promptScore}%` : "0%"}
                  </td>
                  <td className="px-4 py-5 text-center">
                    <div className="flex items-center justify-center gap-2">
                      <span className={`font-serif font-semibold text-xl ${rankColor(p.rank)}`}>
                        {p.rank === "—" || p.rank == null ? "—" : `#${p.rank}`}
                      </span>
                      {p.trend !== undefined && p.trend !== 0 && (
                        <span className={`text-[10px] px-1 py-0.5 rounded-sm font-semibold ${p.trend > 0 ? "bg-[var(--lamp-green-soft)] text-[var(--lamp-green)]" : "bg-[var(--lamp-red-soft)] text-[var(--lamp-red)]"}`}>
                          {p.trend > 0 ? "↑" : "↓"}{Math.abs(p.trend)}
                        </span>
                      )}
                    </div>
                    {p.position && p.position !== "omitted" && (
                      <div className="text-[9px] text-[var(--text-3)] mt-0.5 capitalize">{p.position}</div>
                    )}
                  </td>
                  <td className="px-7 py-5 text-right text-sm text-[var(--text-2)] uppercase tracking-wider text-xs">
                    {p.volume}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="divide-y divide-[var(--rule-1)]">
          {groupedPrompts.map((group, idx) => {
            const isExpanded = !!expandedTopics[group.topic];
            return (
              <div key={group.topic} className="flex flex-col">
                <button
                  onClick={() => toggleTopic(group.topic)}
                  className="w-full text-left px-7 py-5 bg-[var(--panel-1)] hover:bg-[var(--panel-2)]/30 flex items-center justify-between transition-colors focus:outline-hidden"
                >
                  <div className="flex items-center gap-3">
                    {isExpanded ? (
                      <ChevronDown className="w-4 h-4 text-[var(--text-2)]" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-[var(--text-2)]" />
                    )}
                    <div>
                      <h4 className="font-serif text-lg font-bold text-[var(--text-1)]">
                        {group.topic}
                      </h4>
                      <p className="text-[10px] text-[var(--text-3)] uppercase tracking-wider mt-0.5">
                        {group.prompts.length} {group.prompts.length === 1 ? "query" : "queries"}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="text-[9px] text-[var(--text-3)] uppercase tracking-wider block mb-0.5">
                      Avg Score
                    </span>
                    <span className="font-serif font-bold text-xl text-[var(--lamp-amber)]">
                      {group.averageScore}%
                    </span>
                  </div>
                </button>

                {isExpanded && (
                  <div className="bg-[var(--panel-1)] border-t border-[var(--rule-1)] overflow-x-auto">
                    <table className="w-full text-left">
                      <thead>
                        <tr className="border-b border-[var(--rule-1)] bg-[var(--panel-1)]/40">
                          <th className="text-[11px] uppercase tracking-[0.12em] text-[var(--text-2)] font-bold px-12 py-3.5">
                            Prompt
                          </th>
                          <th className="text-[11px] uppercase tracking-[0.12em] text-[var(--text-2)] font-bold text-center px-4 py-3.5 w-24">
                            Score
                          </th>
                          <th className="text-[11px] uppercase tracking-[0.12em] text-[var(--text-2)] font-bold text-center px-4 py-3.5 w-24">
                            Rank
                          </th>
                          <th className="text-[11px] uppercase tracking-[0.12em] text-[var(--text-2)] font-bold text-right px-7 py-3.5 w-28">
                            Volume
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.prompts.map((p, pIdx) => (
                          <tr
                            key={pIdx}
                            className="border-b border-[var(--rule-1)] last:border-0 hover:bg-[var(--panel-1)] transition-colors"
                          >
                            <td className="px-12 py-4 text-sm text-[var(--text-1)]">
                              {renderPromptCell(p)}
                            </td>
                            <td className="px-4 py-4 text-center font-serif font-bold text-base text-[var(--lamp-amber)]">
                              {p.promptScore != null ? `${p.promptScore}%` : "0%"}
                            </td>
                            <td className="px-4 py-4 text-center">
                              <div className="flex items-center justify-center gap-2">
                                <span className={`font-serif font-semibold text-xl ${rankColor(p.rank)}`}>
                                  {p.rank === "—" || p.rank == null ? "—" : `#${p.rank}`}
                                </span>
                              </div>
                              {p.position && p.position !== "omitted" && (
                                <div className="text-[9px] text-[var(--text-3)] mt-0.5 capitalize">{p.position}</div>
                              )}
                            </td>
                            <td className="px-7 py-4 text-right text-xs text-[var(--text-2)] uppercase tracking-wider">
                              {p.volume}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
