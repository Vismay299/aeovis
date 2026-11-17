// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/workflows/AiVisibilityWorkflow.ts, src/server/workflows/auditStepConfigs.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

/**
 * Step presets, ported from OpenSEO's workflow step configs. Every step names
 * its own timeout and retry budget: the platform default burned an hour
 * replaying a doomed step, and a retry of a billed call can post — and bill —
 * twice.
 *
 * Timeouts are capped at 230 s (Vercel's 300 s limit minus one step's headroom)
 * where OpenSEO used 2–10 minutes. Their `POLL_INTERVALS` sleeps become
 * `step.sleep`.
 */
import type { StepOptions } from "./types.ts";

/** Metered and paid steps run once: a retry could post (and bill) twice. */
export const SINGLE_ATTEMPT: StepOptions = { retries: 0, timeoutMs: 120_000, billed: true };

/** A free read (task status, catalogue lookup) can retry. */
export const READ_STEP: StepOptions = { retries: 2, timeoutMs: 120_000 };

/** Small idempotent database steps. */
export const DB_STEP: StepOptions = { retries: 3, timeoutMs: 60_000 };

/** A paid call that legitimately needs most of an invocation. */
export const LONG_PAID_STEP: StepOptions = { retries: 0, timeoutMs: 220_000, billed: true };

export const STEP = { SINGLE_ATTEMPT, READ_STEP, DB_STEP, LONG_PAID_STEP } as const;
