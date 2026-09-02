/**
 * Queue access for the fleet.
 *
 * STUBS UNTIL R1.2.2. The probe_tasks table and lease-based claiming land
 * there; this file exists so the loop in index.js has the seam it will plug
 * into, and so the shape of that seam is decided before the migration is
 * written rather than after.
 *
 * Both functions REFUSE rather than returning an empty result. An empty claim
 * is indistinguishable from an empty queue, and a fleet that reports "nothing
 * to do" forever while its queue fills up is precisely the false-success this
 * rebuild exists to remove. Standing rule 1: a skip is not a success.
 */

const NOT_BUILT =
  "the probe_tasks queue does not exist yet (R1.2.2). This is a stub: it refuses " +
  "rather than returning an empty batch, because an empty batch and an unbuilt " +
  "queue would otherwise look identical.";

/**
 * Claim a batch of probe tasks for this worker.
 * @returns {Promise<Array<{id: string, engine: string, query: string}>>}
 */
export async function claimBatch(_config) {
  throw new Error(`claimBatch: ${NOT_BUILT}`);
}

/**
 * Write typed outcomes back for a claimed batch and release the lease.
 * @param {Array<{id: string, outcome: string}>} _outcomes
 */
export async function reportBatch(_outcomes, _config) {
  throw new Error(`reportBatch: ${NOT_BUILT}`);
}
