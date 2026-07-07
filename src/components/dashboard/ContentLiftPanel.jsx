"use client";

import { useState, useEffect, useCallback } from "react";
import { getContentEvents, addContentEvent } from "@/services/api";
import { toast } from "sonner";
import { motion, AnimatePresence } from "framer-motion";
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
        <div className="lg:col-span-1 bg-white border border-[#E5E2D9] rounded-sm p-6 space-y-6">
          <div>
            <h3 className="font-serif text-xl font-bold text-[#1A1A1A]">Track Content Publish</h3>
            <p className="text-xs text-[#666666] mt-1">
              Log content publications to measure visibility changes across semantically related queries.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="contentUrl" className="block text-xs uppercase tracking-[0.1em] text-[#666666] font-bold mb-2">
                Content URL
              </label>
              <input
                id="contentUrl"
                type="text"
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                placeholder="e.g. acme.com/blog/best-analytics-tool"
                className="w-full bg-white border border-[#E5E2D9] focus:border-[#1A1A1A] focus:ring-1 focus:ring-[#1A1A1A] outline-none rounded-sm px-4 py-3 font-sans text-sm text-[#1A1A1A] transition-all"
                required
              />
            </div>

            <div>
              <label htmlFor="publishDate" className="block text-xs uppercase tracking-[0.1em] text-[#666666] font-bold mb-2">
                Publish Date
              </label>
              <input
                id="publishDate"
                type="date"
                value={publishDate}
                onChange={(e) => setPublishDate(e.target.value)}
                className="w-full bg-white border border-[#E5E2D9] focus:border-[#1A1A1A] focus:ring-1 focus:ring-[#1A1A1A] outline-none rounded-sm px-4 py-3 font-sans text-sm text-[#1A1A1A] transition-all"
                required
              />
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full inline-flex items-center justify-center gap-2 bg-[#1A1A1A] hover:bg-black text-white transition-colors rounded-sm py-3 px-4 font-sans font-semibold text-xs uppercase tracking-wider disabled:opacity-50"
            >
              <Plus className="w-4 h-4" />
              {submitting ? "Registering..." : "Add Content Event"}
            </button>
          </form>
        </div>

        {/* Dynamic Methodology Explainer */}
        <div className="lg:col-span-2 bg-[#FDFBF7] border border-[#E5E2D9] rounded-sm p-6 flex flex-col justify-between">
          <div className="space-y-4">
            <div className="flex items-center gap-2.5">
              <span className="p-2 bg-[#E8F0ED] text-[#2F5C4F] rounded-sm">
                <BookOpen className="w-5 h-5" />
              </span>
              <h3 className="font-serif text-xl font-bold text-[#1A1A1A]">How Content Lift Works</h3>
            </div>
            <p className="text-sm text-[#666666] leading-relaxed">
              When a content event is registered, our system automatically tracks semantic matches on future visibility scans. 
              We identify query prompts matching key terms in your page's path slug and compute the average 
              AI Visibility change.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
              <div className="border border-[#E5E2D9] p-4 bg-white rounded-sm">
                <div className="text-xs uppercase tracking-wider text-[#999999] font-bold">1. Semantic Mapping</div>
                <p className="text-xs text-[#666666] mt-1">
                  Path keywords (e.g. <code>/blog/saas-crm</code>) map automatically to queries containing those terms.
                </p>
              </div>
              <div className="border border-[#E5E2D9] p-4 bg-white rounded-sm">
                <div className="text-xs uppercase tracking-wider text-[#999999] font-bold">2. Score Contrast</div>
                <p className="text-xs text-[#666666] mt-1">
                  Lift compares the average score on these matched queries against the scan immediately preceding it.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Lift Reports List */}
      <div className="bg-white border border-[#E5E2D9] rounded-sm p-6">
        <h3 className="font-serif text-xl font-bold text-[#1A1A1A] mb-6">Performance Lift Reports</h3>

        {loading ? (
          <div className="text-center py-12 text-[#999999] text-sm">Loading reports...</div>
        ) : events.length === 0 ? (
          <div className="text-center py-12 border border-dashed border-[#E5E2D9] rounded-sm bg-[#FDFBF7] text-[#666666]">
            <AlertCircle className="w-8 h-8 text-[#999999] mx-auto mb-2" />
            <p className="text-sm font-semibold">No content events tracked yet</p>
            <p className="text-xs text-[#999999] mt-1">Add a URL on the left to start measuring content lift.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {events.map((event) => {
              const hasLift = event.lift !== null;
              const isPositive = hasLift && event.lift > 0;
              const isNegative = hasLift && event.lift < 0;
              const isExpanded = expandedEventId === event.id;

              return (
                <div key={event.id} className="border border-[#E5E2D9] rounded-sm overflow-hidden transition-all hover:border-[#1A1A1A]">
                  {/* Event summary row */}
                  <div
                    onClick={() => setExpandedEventId(isExpanded ? null : event.id)}
                    className="p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 cursor-pointer bg-white hover:bg-[#FDFBF7] transition-colors select-none"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <LinkIcon className="w-4 h-4 text-[#999999]" />
                        <span className="font-sans font-bold text-sm text-[#1A1A1A] truncate max-w-md">
                          {event.url}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-[#666666]">
                        <span className="flex items-center gap-1">
                          <Calendar className="w-3.5 h-3.5" />
                          Published {new Date(event.publish_date).toLocaleDateString()}
                        </span>
                        <span>·</span>
                        <span>{event.related_prompts?.length || 0} matching queries</span>
                      </div>
                      {event.lift !== null && (
                        <p className="text-xs text-[#666666]">
                          After publishing {event.url.replace(/^https?:\/\/[^/]+/i, "") || event.url}:{" "}
                          <span className={event.lift > 0 ? "text-[#2F5C4F] font-semibold" : event.lift < 0 ? "text-[#8B3A3A] font-semibold" : "font-semibold text-[#1A1A1A]"}>
                            {event.lift > 0 ? "+" : ""}{event.lift}%
                          </span>{" "}
                          on {event.related_prompts?.length || 0} related prompt{(event.related_prompts?.length || 0) === 1 ? "" : "s"}
                        </p>
                      )}
                    </div>

                    <div className="flex items-center gap-6">
                      {/* Lift indicator */}
                      <div className="text-right">
                        <div className="text-xs uppercase tracking-wider text-[#999999] font-bold">Visibility Lift</div>
                        <div className="flex items-center gap-1.5 mt-1 justify-end">
                          {hasLift ? (
                            <>
                              {isPositive ? (
                                <TrendingUp className="w-4 h-4 text-[#2F5C4F]" />
                              ) : isNegative ? (
                                <TrendingDown className="w-4 h-4 text-[#8B3A3A]" />
                              ) : null}
                              <span className={`text-base font-bold ${isPositive ? "text-[#2F5C4F]" : isNegative ? "text-[#8B3A3A]" : "text-[#666666]"}`}>
                                {isPositive ? "+" : ""}{event.lift}%
                              </span>
                            </>
                          ) : (
                            <span className="text-xs text-[#999999] italic">Awaiting rescan</span>
                          )}
                        </div>
                      </div>

                      <div className="text-[#999999]">
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
                        className="border-t border-[#E5E2D9] bg-[#FDFBF7] overflow-hidden"
                      >
                        <div className="p-5 space-y-4">
                          <h4 className="text-xs uppercase tracking-wider text-[#1A1A1A] font-bold">Matching Queries details</h4>
                          {event.related_prompts?.length === 0 ? (
                            <p className="text-xs text-[#666666] italic">No matching queries found in the latest scan.</p>
                          ) : (
                            <div className="divide-y divide-[#E5E2D9] border-t border-b border-[#E5E2D9]">
                              {event.related_prompts.map((promptText, idx) => (
                                <div key={idx} className="py-3 flex justify-between items-center text-xs">
                                  <span className="text-[#1A1A1A] font-medium">{promptText}</span>
                                  <div className="flex gap-4 text-[#666666]">
                                    <span>Before: <strong className="text-[#1A1A1A]">{event.previous_score !== null ? `${event.previous_score}%` : "—"}</strong></span>
                                    <span>After: <strong className="text-[#1A1A1A]">{event.current_score !== null ? `${event.current_score}%` : "—"}</strong></span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                          <div className="flex items-center justify-between text-xs text-[#666666] pt-1">
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
