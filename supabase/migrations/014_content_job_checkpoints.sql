-- 014: Per-block checkpoints on content_jobs (R3.5.1)
--
-- A content job killed mid-run now resumes at the next block without
-- repeating a paid LLM call.  The worker writes a JSON checkpoint at every
-- block boundary; on rescue it reads the checkpoint, restores the built-up
-- context (work_order, research_pack, benchmark_notes, draft, …), and
-- skips blocks whose slugs appear in completedBlocks.
--
-- Follows the same pattern scan_jobs uses for its probe-phase checkpoints.

ALTER TABLE content_jobs ADD COLUMN IF NOT EXISTS checkpoint jsonb;
