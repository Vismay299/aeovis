/**
 * Probe execution.
 *
 * STUB UNTIL R1.3. The Perplexity adapter is the first real one; ChatGPT
 * follows. Each returns a TYPED outcome from the agreed vocabulary
 * (answered / no_answer / blocked / captcha / login_wall / timeout /
 * parse_error / skipped) so that "blocked" can never be scored as
 * "not mentioned" — decision D2 of the rebuild.
 *
 * Refuses rather than returning a plausible empty result, for the same reason
 * queue.js does.
 */

/** The typed outcomes an adapter may report. Frozen so a typo cannot invent one. */
export const PROBE_OUTCOMES = Object.freeze([
  "answered",
  "no_answer",
  "blocked",
  "captcha",
  "login_wall",
  "timeout",
  "parse_error",
  "skipped",
]);

export async function probeBatch(_batch, _config) {
  throw new Error(
    "probeBatch: no adapter is built yet (R1.3). This is a stub: it refuses rather " +
      "than returning zero-valued rows, which would score as real non-mentions."
  );
}
