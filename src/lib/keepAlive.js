/**
 * R3.1.5 — keep post-response work alive on the platform.
 *
 * Every route that starts work and then returns (`runScanChunk(id).catch(...)`
 * after a 201, the sweep's dispatch, the content-job start, the self-continue
 * fetch) used to rely on nothing: once the response was sent, Vercel was free
 * to freeze the instance mid-scan. The system stayed upright only through three
 * compensations — heartbeat staleness, the poll-driven rescue in
 * /api/scan/[job_id]/status, and the daily crons. Those stay; this makes them
 * the backstop instead of the only guarantee.
 *
 * `waitUntil` from @vercel/functions registers the promise with the request
 * context, so the function stays alive until it settles (bounded by the
 * route's maxDuration). Off Vercel there is no context and the promise simply
 * runs, exactly as before — so local dev and tests are unchanged.
 *
 * The promise's rejection is always handled here (logged under `label`), so a
 * caller never needs its own `.catch` and a failure can never become an
 * unhandled rejection.
 */

import { waitUntil as platformWaitUntil } from "@vercel/functions";

/**
 * @param {Promise<unknown>|(() => Promise<unknown>)} work the post-response work
 * @param {object} [opts]
 * @param {string} [opts.label] names the work in the failure log
 * @param {number} [opts.maxMs] stop holding the instance after this long. The
 *   work itself is NOT cancelled; the platform is just no longer asked to wait.
 *   For fire-a-request-and-move-on work (self-continue) where waiting for the
 *   response would double-bill a whole chunk.
 * @param {(p: Promise<unknown>) => void} [opts.waitUntil] injected by tests
 * @param {{error: Function}} [opts.logger]
 * @returns {Promise<void>} settles when the (possibly capped) wait ends; never rejects
 */
export function keepAlive(work, opts = {}) {
  const { label = "background work", maxMs, logger = console } = opts;
  const register = opts.waitUntil ?? platformWaitUntil;

  let promise;
  try {
    promise = Promise.resolve(typeof work === "function" ? work() : work);
  } catch (err) {
    promise = Promise.reject(err);
  }

  const handled = promise.then(
    () => undefined,
    (err) => {
      logger.error(`[keep-alive] ${label} failed:`, err?.message ?? err);
    }
  );

  let held = handled;
  if (Number.isFinite(maxMs) && maxMs > 0) {
    let timer;
    held = Promise.race([
      handled,
      new Promise((resolve) => {
        timer = setTimeout(resolve, maxMs);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  try {
    register(held);
  } catch (err) {
    // A platform helper that throws must not take the response down with it;
    // the work is already running and its failure is already handled.
    logger.error(`[keep-alive] could not register ${label} with the platform:`, err?.message ?? err);
  }
  return held;
}
