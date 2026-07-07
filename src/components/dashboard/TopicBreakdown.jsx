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
      className="bg-white border border-[#E5E2D9] rounded-sm p-6"
    >
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="font-serif text-xl font-semibold text-[#1A1A1A]">
            Visibility by Topic Category
          </h3>
          <p className="text-xs text-[#666666] mt-0.5">
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
                <span className="font-semibold text-[#1A1A1A]">{topic}</span>
                <span className="font-serif font-bold text-sm text-[#D9531E]">
                  {score}%
                </span>
              </div>
              <div className="h-2 w-full bg-[#E5E2D9] rounded-full overflow-hidden relative">
                <div
                  className="h-full bg-[#2F5C4F] rounded-full transition-all duration-500"
                  style={{ width: `${score}%` }}
                />
              </div>
            </motion.div>
          );
        })}
      </div>

      <div className="mt-5 pt-4 border-t border-[#E5E2D9] flex items-center gap-1.5 text-[11px] text-[#999999]">
        <FolderHeart className="w-3.5 h-3.5 text-[#2F5C4F]" />
        <span>Categorized automatically based on semantic keyword mapping.</span>
      </div>
    </div>
  );
};
