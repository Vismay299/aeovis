import React from "react";
import { motion } from "framer-motion";
import { FolderHeart } from "lucide-react";

export const TopicBreakdown = ({ topicScores }) => {
  if (!topicScores || Object.keys(topicScores).length === 0) return null;

  // Sort topics by score descending
  const sortedTopics = Object.entries(topicScores)
    .map(([topic, score]) => ({ topic, score }))
    .sort((a, b) => b.score - a.score);

  return (
    <div
      data-testid="topic-breakdown"
      className="bg-[var(--panel-1)] border border-[var(--rule-1)] rounded-sm p-6"
    >
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="font-serif text-xl font-semibold text-[var(--text-1)]">
            Visibility by Topic Category
          </h3>
          <p className="text-xs text-[var(--text-2)] mt-0.5">
            Compare visibility across different prompt topic verticals
          </p>
        </div>
      </div>

      <div className="space-y-4">
        {sortedTopics.map(({ topic, score }, index) => {
          return (
            <motion.div 
              key={topic}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.3, delay: index * 0.05 }}
              className="space-y-1.5"
            >
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-[var(--text-1)]">{topic}</span>
                <span className="font-serif font-bold text-sm text-[var(--lamp-amber)]">
                  {score}%
                </span>
              </div>
              <div className="h-2 w-full bg-[var(--rule-1)] rounded-full overflow-hidden relative">
                <div
                  className="h-full bg-[var(--lamp-green)] rounded-full transition-all duration-500"
                  style={{ width: `${score}%` }}
                />
              </div>
            </motion.div>
          );
        })}
      </div>

      <div className="mt-5 pt-4 border-t border-[var(--rule-1)] flex items-center gap-1.5 text-[11px] text-[var(--text-3)]">
        <FolderHeart className="w-3.5 h-3.5 text-[var(--lamp-green)]" />
        <span>Categorized automatically based on semantic keyword mapping.</span>
      </div>
    </div>
  );
};
