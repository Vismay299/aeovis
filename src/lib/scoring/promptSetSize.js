/**
 * How many unbranded prompts a scan tracks — one source of truth.
 *
 * R2.10.1. The landing page advertised 36 in five places ("36 questions, none
 * of which name you", "See all 36 answers", "Free · 36 questions · no signup",
 * and the hero) while scanWorker's default was 30 and every archived reference
 * scan recorded prompts_tracked=30. The page promised a fifth more than the
 * product delivered, which is the same class of overclaim as naming an engine
 * the deployment does not probe.
 *
 * Client-safe: a plain constant with no env read and no server imports, so the
 * marketing surface and the worker cannot drift.
 *
 * A deployment that raises PROMPT_TARGET gets MORE than this; the number here
 * is what a free scan tracks by default, which is what the page is promising.
 * Under-promising is the safe direction.
 */
export const DEFAULT_UNBRANDED_TARGET = 30;

/** Bounds resolvePromptTarget clamps an override to. */
export const MIN_UNBRANDED_TARGET = 10;
export const MAX_UNBRANDED_TARGET = 100;
