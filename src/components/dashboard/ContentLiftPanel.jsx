"use client";

import { useState, useEffect, useCallback } from "react";
import { getContentEvents, addContentEvent } from "@/shared/api";
import { toast } from "sonner";
import { motion, AnimatePresence } from "motion/react";
import { Plus, Calendar, Link as LinkIcon, TrendingUp, TrendingDown, BookOpen, AlertCircle, ChevronDown, ChevronUp } from "lucide-react";

export default function ContentLiftPanel({ brand }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newUrl, setNewUrl] = useState("");
  const [publishDate, setPublishDate] = useState(new Date().toISOString().split("T")[0]);
  const [submitting, setSubmitting] = useState(false);
  const [expandedEventId, setExpandedEventId] = useState(null);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getContentEvents(brand);
      setEvents(data || []);
    } catch (e) {
      toast.error("Failed to load content lift events");
    } finally {
      setLoading(false);
    }
  }, [brand]);

  useEffect(() => {
    fetchEvents();
  }, [brand, fetchEvents]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!newUrl.trim()) return;

    setSubmitting(true);
    try {
      const cleanUrl = newUrl.trim();
      const res = await addContentEvent({
        brand,
        url: cleanUrl,
        publishDate: new Date(publishDate).toISOString()
      });

      if (res) {
        toast.success("Content event added successfully!");
        setNewUrl("");
        fetchEvents();
      } else {
        toast.error("Failed to add content event");
      }
    } catch (err) {
      toast.error("An error occurred");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Upper Grid: Add Event + Summary */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        
        {/* Register Content Form */}
        <div className="lg:col-span-1 bg-[var(--panel-1)] border border-[var(--rule-1)] rounded-sm p-6 space-y-6">
          <div>
            <h3 className="font-serif text-xl font-bold text-[var(--text-1)]">Track Content Publish</h3>
            <p className="text-xs text-[var(--text-2)] mt-1">
              Log content publications to measure visibility changes across semantically related queries.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="contentUrl" className="block text-xs uppercase tracking-[0.1em] text-[var(--text-2)] font-bold mb-2">
                Content URL
              </label>
              <input
                id="contentUrl"
                type="text"
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                placeholder="e.g. acme.com/blog/best-analytics-tool"
                className="w-full bg-[var(--panel-1)] border border-[var(--rule-1)] focus:border-[var(--text-1)] focus:ring-1 focus:ring-[var(--text-1)] outline-hidden rounded-sm px-4 py-3 font-sans text-sm text-[var(--text-1)] transition-all"
                required
              />
            </div>

            <div>
              <label htmlFor="publishDate" className="block text-xs uppercase tracking-[0.1em] text-[var(--text-2)] font-bold mb-2">
                Publish Date
              </label>
              <input
                id="publishDate"
                type="date"
                value={publishDate}
                onChange={(e) => setPublishDate(e.target.value)}
                className="w-full bg-[var(--panel-1)] border border-[var(--rule-1)] focus:border-[var(--text-1)] focus:ring-1 focus:ring-[var(--text-1)] outline-hidden rounded-sm px-4 py-3 font-sans text-sm text-[var(--text-1)] transition-all"
                required
              />
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full inline-flex items-center justify-center gap-2 bg-[var(--text-1)] hover:bg-black text-white transition-colors rounded-sm py-3 px-4 font-sans font-semibold text-xs uppercase tracking-wider disabled:opacity-50"
            >
              <Plus className="w-4 h-4" />
              {submitting ? "Registering..." : "Add Content Event"}
            </button>
          </form>
        </div>

        {/* Dynamic Methodology Explainer */}
        <div className="lg:col-span-2 bg-[var(--panel-1)] border border-[var(--rule-1)] rounded-sm p-6 flex flex-col justify-between">
          <div className="space-y-4">
            <div className="flex items-center gap-2.5">
              <span className="p-2 bg-[var(--lamp-green-soft)] text-[var(--lamp-green)] rounded-sm">
                <BookOpen className="w-5 h-5" />
              </span>
              <h3 className="font-serif text-xl font-bold text-[var(--text-1)]">How Content Lift Works</h3>
            </div>
            <p className="text-sm text-[var(--text-2)] leading-relaxed">
              When a content event is registered, our system automatically tracks semantic matches on future visibility scans. 
              We identify query prompts matching key terms in your page's path slug and compute the average 
              AI Visibility change.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
              <div className="border border-[var(--rule-1)] p-4 bg-[var(--panel-1)] rounded-sm">
                <div className="text-xs uppercase tracking-wider text-[var(--text-3)] font-bold">1. Semantic Mapping</div>
                <p className="text-xs text-[var(--text-2)] mt-1">
                  Path keywords (e.g. <code>/blog/saas-crm</code>) map automatically to queries containing those terms.
                </p>
              </div>
              <div className="border border-[var(--rule-1)] p-4 bg-[var(--panel-1)] rounded-sm">
                <div className="text-xs uppercase tracking-wider text-[var(--text-3)] font-bold">2. Score Contrast</div>
                <p className="text-xs text-[var(--text-2)] mt-1">
                  Lift compares the average score on these matched queries against the scan immediately preceding it.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Lift Reports List */}
      <div className="bg-[var(--panel-1)] border border-[var(--rule-1)] rounded-sm p-6">
        <h3 className="font-serif text-xl font-bold text-[var(--text-1)] mb-6">Performance Lift Reports</h3>

        {loading ? (
          <div className="text-center py-12 text-[var(--text-3)] text-sm">Loading reports...</div>
        ) : events.length === 0 ? (
          <div className="text-center py-12 border border-dashed border-[var(--rule-1)] rounded-sm bg-[var(--panel-1)] text-[var(--text-2)]">
            <AlertCircle className="w-8 h-8 text-[var(--text-3)] mx-auto mb-2" />
            <p className="text-sm font-semibold">No content events tracked yet</p>
            <p className="text-xs text-[var(--text-3)] mt-1">Add a URL on the left to start measuring content lift.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {events.map((event) => {
              const hasLift = event.lift !== null;
              const isPositive = hasLift && event.lift > 0;
              const isNegative = hasLift && event.lift < 0;
              const isExpanded = expandedEventId === event.id;
              // R2.8.20 — a row whose URL was synthesized on approval (finding B13)
              // is not a real publication and must not be presented as awaiting rescan.
              const isFabricated = !!event.fabricated_url;

              return (
                <div key={event.id} className="border border-[var(--rule-1)] rounded-sm overflow-hidden transition-all hover:border-[var(--text-1)]">
                  {/* Event summary row */}
                  <div
                    onClick={() => setExpandedEventId(isExpanded ? null : event.id)}
                    className="p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 cursor-pointer bg-[var(--panel-1)] hover:bg-[var(--panel-1)] transition-colors select-none"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <LinkIcon className="w-4 h-4 text-[var(--text-3)]" />
                        {isFabricated ? (
                          <span className="font-sans font-bold text-sm text-[var(--text-3)] truncate max-w-md line-through" data-testid="fabricated-url">
                            {event.url}
                          </span>
                        ) : (
                          <span className="font-sans font-bold text-sm text-[var(--text-1)] truncate max-w-md">
                            {event.url}
                          </span>
                        )}
                        {/* R2.8.20 — fabricated URL gets a visible chip, not a rescan promise */}
                        {isFabricated && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-sm bg-[var(--lamp-amber-soft)] text-[var(--lamp-amber)]" data-testid="fabricated-chip">
                            URL was fabricated
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-[var(--text-2)]">
                        <span className="flex items-center gap-1">
                          <Calendar className="w-3.5 h-3.5" />
                          {isFabricated ? "Never published" : `Published ${new Date(event.publish_date).toLocaleDateString()}`}
                        </span>
                        <span>·</span>
                        <span>{event.related_prompts?.length || 0} matching queries</span>
                      </div>
                      {/* R2.8.20 — fabricated rows do not show lift copy */}
                      {!isFabricated && event.lift !== null && (
                        <p className="text-xs text-[var(--text-2)]">
                          After publishing {event.url.replace(/^https?:\/\/[^/]+/i, "") || event.url}:{" "}
                          <span className={event.lift > 0 ? "text-[var(--lamp-green)] font-semibold" : event.lift < 0 ? "text-[var(--lamp-red)] font-semibold" : "font-semibold text-[var(--text-1)]"}>
                            {event.lift > 0 ? "+" : ""}{event.lift}%
                          </span>{" "}
                          on {event.related_prompts?.length || 0} related prompt{(event.related_prompts?.length || 0) === 1 ? "" : "s"}
                        </p>
                      )}
                    </div>

                    <div className="flex items-center gap-6">
                      {/* Lift indicator */}
                      <div className="text-right">
                        <div className="text-xs uppercase tracking-wider text-[var(--text-3)] font-bold">Visibility Lift</div>
                        <div className="flex items-center gap-1.5 mt-1 justify-end">
                          {isFabricated ? (
                            /* R2.8.20 — fabricated URL: no rescan promise, show the truth */
                            <span className="text-xs text-[var(--lamp-amber)] italic" data-testid="fabricated-lift-status">
                              Never published
                            </span>
                          ) : hasLift ? (
                            <>
                              {isPositive ? (
                                <TrendingUp className="w-4 h-4 text-[var(--lamp-green)]" />
                              ) : isNegative ? (
                                <TrendingDown className="w-4 h-4 text-[var(--lamp-red)]" />
                              ) : null}
                              <span className={`text-base font-bold ${isPositive ? "text-[var(--lamp-green)]" : isNegative ? "text-[var(--lamp-red)]" : "text-[var(--text-2)]"}`}>
                                {isPositive ? "+" : ""}{event.lift}%
                              </span>
                            </>
                          ) : (
                            <span className="text-xs text-[var(--text-3)] italic">Awaiting rescan</span>
                          )}
                        </div>
                      </div>

                      <div className="text-[var(--text-3)]">
                        {isExpanded ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
                      </div>
                    </div>
                  </div>

                  {/* Expanded Detail view */}
                  <AnimatePresence>
                    {isExpanded && (
                      <motion.div
                        initial={{ height: 0 }}
                        animate={{ height: "auto" }}
                        exit={{ height: 0 }}
                        className="border-t border-[var(--rule-1)] bg-[var(--panel-1)] overflow-hidden"
                      >
                        <div className="p-5 space-y-4">
                          <h4 className="text-xs uppercase tracking-wider text-[var(--text-1)] font-bold">Matching Queries details</h4>
                          {event.related_prompts?.length === 0 ? (
                            <p className="text-xs text-[var(--text-2)] italic">No matching queries found in the latest scan.</p>
                          ) : (
                            <div className="divide-y divide-[var(--rule-1)] border-t border-b border-[var(--rule-1)]">
                              {event.related_prompts.map((promptText, idx) => (
                                <div key={idx} className="py-3 flex justify-between items-center text-xs">
                                  <span className="text-[var(--text-1)] font-medium">{promptText}</span>
                                  <div className="flex gap-4 text-[var(--text-2)]">
                                    <span>Before: <strong className="text-[var(--text-1)]">{event.previous_score !== null ? `${event.previous_score}%` : "—"}</strong></span>
                                    <span>After: <strong className="text-[var(--text-1)]">{event.current_score !== null ? `${event.current_score}%` : "—"}</strong></span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                          <div className="flex items-center justify-between text-xs text-[var(--text-2)] pt-1">
                            <span>* Lift calculations require running a new scan after content publications.</span>
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
