import React, { useState, useEffect } from "react";
import { Plus, CheckCircle2, AlertCircle, Sparkles } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { normalizeTopic } from "@/lib/scoring/topics";

const INTENT_LABELS = {
  high_intent: "High Intent",
  comparison: "Comparison",
  problem_aware: "Problem Aware",
  exploratory: "Exploratory",
  branded: "Branded"
};

export const QueryManager = ({ brand, currentPrompts = [], onPromptAdded }) => {
  const [prompts, setPrompts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newText, setNewText] = useState("");
  const [newIntent, setNewIntent] = useState("high_intent");
  const [newTopic, setNewTopic] = useState("General");
  const [actionLoading, setActionLoading] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    async function fetchPrompts() {
      try {
        const res = await fetch(`/api/brands/${encodeURIComponent(brand)}/prompts?includeDisabled=true`);
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
  }, [brand]);

  // If database is empty, fallback to the current scan's prompts
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
        
        // Refresh prompts
        const refresh = await fetch(`/api/brands/${encodeURIComponent(brand)}/prompts?includeDisabled=true`);
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
        
        // Refresh prompts
        const refresh = await fetch(`/api/brands/${encodeURIComponent(brand)}/prompts?includeDisabled=true`);
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
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
      {/* Left pane: Add query */}
      <div className="lg:col-span-1 bg-white border border-[#E5E2D9] rounded-sm p-6 self-start">
        <h3 className="font-serif text-xl font-semibold text-[#1A1A1A] mb-2 flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-[#D9531E]" />
          Add Custom Query
        </h3>
        <p className="text-xs text-[#666666] mb-6 leading-relaxed">
          Target specific customer questions or keyword variations. Your AEO Visibility score will automatically incorporate these in the next scan.
        </p>

        <form onSubmit={handleAddPrompt} className="space-y-5">
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-[#1A1A1A] font-bold mb-2">
              Query Text
            </label>
            <textarea
              required
              rows={3}
              value={newText}
              onChange={(e) => setNewText(e.target.value)}
              placeholder="e.g. What is the best CRM software for real estate agencies?"
              className="w-full text-sm border border-[#E5E2D9] p-3 focus:outline-none focus:border-[#1A1A1A] rounded-sm font-sans resize-none"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-[#1A1A1A] font-bold mb-2">
                Intent Tier
              </label>
              <select
                value={newIntent}
                onChange={(e) => setNewIntent(e.target.value)}
                className="w-full text-xs border border-[#E5E2D9] p-2.5 focus:outline-none focus:border-[#1A1A1A] rounded-sm font-sans bg-transparent"
              >
                <option value="high_intent">High Intent</option>
                <option value="comparison">Comparison</option>
                <option value="problem_aware">Problem Aware</option>
                <option value="exploratory">Exploratory</option>
                <option value="branded">Branded</option>
              </select>
            </div>

            <div>
              <label className="block text-[10px] uppercase tracking-wider text-[#1A1A1A] font-bold mb-2">
                Topic / Category
              </label>
              <input
                type="text"
                value={newTopic}
                onChange={(e) => setNewTopic(e.target.value)}
                placeholder="e.g. Features"
                className="w-full text-xs border border-[#E5E2D9] p-2.5 focus:outline-none focus:border-[#1A1A1A] rounded-sm font-sans"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={actionLoading || !newText.trim()}
            className="w-full bg-[#1A1A1A] text-white hover:bg-[#D9531E] transition-colors rounded-sm py-3 text-xs uppercase tracking-widest font-semibold flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Plus className="w-4 h-4" />
            Add Query
          </button>
        </form>

        <AnimatePresence>
          {message && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className={`mt-5 p-3 rounded-sm text-xs font-medium flex items-start gap-2 ${message.type === "success" ? "bg-[#E8F0ED] text-[#2F5C4F]" : "bg-[#F9ECEC] text-[#8B3A3A]"}`}
            >
              {message.type === "success" ? <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" /> : <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />}
              <span>{message.text}</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Right pane: list */}
      <div className="lg:col-span-2 bg-white border border-[#E5E2D9] rounded-sm p-6 md:p-8">
        <div className="flex justify-between items-center border-b border-[#E5E2D9] pb-4 mb-6">
          <div>
            <h3 className="font-serif text-2xl font-semibold text-[#1A1A1A]">
              Currently Tracked Queries
            </h3>
            <p className="text-xs text-[#666666] mt-1">
              Active prompt set for visibility scans.
            </p>
          </div>
          <span className="text-xs font-semibold px-2.5 py-1 bg-[#F3F0E6] rounded-full text-[#1A1A1A]">
            {displayPrompts.length} total
          </span>
        </div>

        {loading ? (
          <div className="py-20 text-center text-sm text-[#999999]">
            Loading tracked queries...
          </div>
        ) : displayPrompts.length === 0 ? (
          <div className="py-20 text-center text-sm text-[#999999]">
            No tracked queries. Run your first scan to generate them automatically.
          </div>
        ) : (
          <div className="space-y-4 max-h-[600px] overflow-y-auto pr-2">
            {displayPrompts.map((p, idx) => (
              <div
                key={p.id}
                className={`flex items-start justify-between gap-4 border border-[#E5E2D9] hover:border-[#1A1A1A] transition-colors rounded-sm p-4 bg-[#FDFBF7] ${!p.enabled ? "opacity-60 bg-[#F3F0E6]/30" : ""}`}
              >
                <div className="space-y-2">
                  <p className={`text-sm font-medium leading-relaxed ${p.enabled ? "text-[#1A1A1A]" : "text-[#999999] line-through"}`}>
                    {p.text}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    {p.intent_tier && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-sm bg-[#F3F0E6] text-[9px] font-semibold text-[#1A1A1A] uppercase tracking-wider">
                        🎯 {INTENT_LABELS[p.intent_tier] || p.intent_tier.replace("_", " ")}
                      </span>
                    )}
                    {p.topic && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-sm bg-[#FFF8F5] text-[9px] font-semibold text-[#D9531E] uppercase tracking-wider">
                        📁 {normalizeTopic(p.topic)}
                      </span>
                    )}
                    {!p.enabled && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-sm bg-[#F9ECEC] text-[9px] font-bold text-[#8B3A3A] uppercase tracking-wider">
                        🚫 Disabled
                      </span>
                    )}
                  </div>
                </div>
                
                <div className="flex items-center gap-2 shrink-0 pt-0.5">
                  <label className="relative inline-flex items-center cursor-pointer select-none">
                    <input 
                      type="checkbox" 
                      checked={!!p.enabled}
                      disabled={actionLoading}
                      onChange={() => handleTogglePrompt(p.id, p.text, !!p.enabled)}
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-[#E5E2D9] rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:border-[#E5E2D9] after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[#2F5C4F]"></div>
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
