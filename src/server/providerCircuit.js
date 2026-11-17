/**
 * R02.5a/b — provider circuits and spend reservations, shared by every worker.
 *
 * The audit's number for this repair is 34: "a permanently rejected credential
 * [was retried] 34 times" per engine, in one scan, because nothing above the
 * individual probe knew that a 401 is a fact about the ACCOUNT rather than
 * about the question. A circuit is that knowledge. It is scoped to
 * provider + configuration identity — not to the job, not to the engine and not
 * to the tenant — because the sharing is the whole point: one shared gateway
 * credential failing stops every engine that routes through it, and an
 * unrelated provider keeps working (R02-17/R02-18).
 *
 * WHY THE STATE IS IN-PROCESS HERE, AND WHAT THAT DOES NOT PROVE: the durable,
 * cross-process half of R02.5a is a database row with a conditional update, and
 * that half is NOT implemented in this pass (R02-07..R02-16, R02-19, R02-20 and
 * R02-22 need real transactions). What is implemented is the POLICY: which
 * failures open a circuit, which do not, what a refusal says, that exactly one
 * half-open canary is claimed, and that a spend reservation is checked and
 * recorded before any network call. Those are the decisions a caller cannot get
 * wrong later, and they are testable without a database. The wiring note in the
 * repair report names the exact seam that must become transactional.
 *
 * NOTHING HERE SPENDS, DISPATCHES OR LOGS. A refusal is a returned value with a
 * reason, and `authorizeDispatch` is meant to be called BEFORE the fetch, so
 * that "refusals are recorded before any network call" is structural rather
 * than a promise about the order of two statements.
 */

import { PROVIDER_FAILURE, opensProviderCircuit } from "../shared/engines/providerFailure.js";

export const CIRCUIT_STATE = Object.freeze({
  CLOSED: "closed",
  OPEN: "open",
  HALF_OPEN: "half_open",
});

/** Why a dispatch was refused. Closed vocabulary, so a caller cannot mis-read a refusal as an outage. */
export const DISPATCH_REFUSAL = Object.freeze({
  CIRCUIT_OPEN: "circuit_open",
  HALF_OPEN_CANARY_IN_FLIGHT: "half_open_canary_in_flight",
  SPEND_RESERVED: "spend_reservation_refused",
});

export const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * The identity a circuit is scoped to (R02.5a): the provider and the ACCOUNT
 * behind it.
 *
 * `account` is the readiness module's credential fingerprint — provider, route
 * and a one-way digest of the credential actually called — and NOT
 * `config_version`, which also carries the MODEL. That distinction is the whole
 * shared-circuit story: a revoked OpenRouter key fails `openai/gpt-6-luna` and
 * `perplexity/sonar` alike, so scoping on the model would leave the second
 * engine to discover the same dead credential with its own paid call. Scoping on
 * the account stops every dependent engine at once (R02-17), while a rotation
 * still gets a fresh circuit, because the digest moves and the old broken key's
 * circuit cannot block the new one.
 *
 * @param {{provider: string, account?: string|null}} identity
 * @returns {string}
 */
export function circuitKey({ provider, account = null } = {}) {
  return `${provider ?? "unknown-provider"}::${account ?? "unidentified-account"}`;
}

/**
 * One breaker for one provider + account.
 *
 * @param {object} input
 * @param {string} input.provider named in every refusal
 * @param {string|null} [input.account] the credential identity, from the plan
 * @param {() => number} [input.now] clock seam
 * @param {number} [input.cooldownMs]
 */
export function createCircuitBreaker({ provider, account = null, now = () => Date.now(), cooldownMs = DEFAULT_COOLDOWN_MS } = {}) {
  if (!provider) throw new Error("createCircuitBreaker: a provider is required — a circuit nobody can name cannot be acted on");

  const key = circuitKey({ provider, account });
  let state = CIRCUIT_STATE.CLOSED;
  let openedAtMs = null;
  let openedByKind = null;
  // The single half-open slot. `null` means "nobody holds the canary"; the
  // transition from null to an owner happens in one synchronous step, which is
  // what makes "exactly one canary" true without a lock.
  let canaryOwner = null;
  let canaryClaimedAtMs = null;

  function halfOpenDue(atMs) {
    return state === CIRCUIT_STATE.OPEN && openedAtMs !== null && atMs - openedAtMs >= cooldownMs;
  }

  /** A refusal sentence that names the provider AND the account it applies to. */
  function refusalReason(kind, extra) {
    return `${provider} (account ${account ?? "unidentified"}) ${kind}${extra ? `; ${extra}` : ""}`;
  }

  return {
    provider,
    account,
    key,

    state() {
      return state;
    },

    opened() {
      return state === CIRCUIT_STATE.OPEN || state === CIRCUIT_STATE.HALF_OPEN
        ? { at_ms: openedAtMs, kind: openedByKind, key }
        : null;
    },

    /**
     * Feed one classification in.
     *
     * Opens on the permanent credential/budget faults the backlog names, and on
     * nothing else. A challenge, a timeout and a rate limit are facts about ONE
     * attempt; opening a shared circuit for them would stop healthy engines for
     * a condition that clears by itself.
     *
     * @param {{kind: string, message?: string|null}|null} classification
     * @returns {{action: "open"|"none", kind: string|null, key: string, reason: string|null}}
     */
    record(classification) {
      if (!classification || !opensProviderCircuit(classification.kind)) {
        return { action: "none", kind: classification?.kind ?? null, key, reason: null };
      }
      state = CIRCUIT_STATE.OPEN;
      openedAtMs = now();
      openedByKind = classification.kind;
      canaryOwner = null;
      canaryClaimedAtMs = null;
      return {
        action: "open",
        kind: classification.kind,
        key,
        reason: refusalReason(
          `stopped dispatching after a permanent ${classification.kind} failure`,
          classification.message ?? undefined
        ),
      };
    },

    /**
     * Claim the ONE half-open canary. Exactly one caller wins per open window.
     *
     * @param {string} owner
     * @returns {boolean}
     */
    claimHalfOpenCanary(owner) {
      if (!owner) throw new Error("claimHalfOpenCanary: an owner is required — an unowned canary cannot be released");
      const atMs = now();
      if (halfOpenDue(atMs)) {
        state = CIRCUIT_STATE.HALF_OPEN;
        openedAtMs = atMs;
        canaryOwner = null;
        canaryClaimedAtMs = null;
      }
      if (state !== CIRCUIT_STATE.HALF_OPEN) return false;
      if (canaryOwner !== null) return canaryOwner === owner;
      // The check-and-set. One synchronous statement, so two contenders cannot
      // both observe `null`.
      canaryOwner = owner;
      canaryClaimedAtMs = atMs;
      return true;
    },

    /** The canary's verdict: a success closes the circuit for everyone. */
    close() {
      state = CIRCUIT_STATE.CLOSED;
      openedAtMs = null;
      openedByKind = null;
      canaryOwner = null;
      canaryClaimedAtMs = null;
      return { action: "close", key };
    },

    /**
     * May this owner dispatch right now?
     *
     * @param {string} [owner]
     * @returns {{allowed: boolean, state: string, reason: string|null, refusal: object|null}}
     */
    verdict(owner = null) {
      const atMs = now();
      if (state === CIRCUIT_STATE.CLOSED) {
        return { allowed: true, state, reason: null, refusal: null };
      }
      if (halfOpenDue(atMs)) {
        // Time to let exactly one probe through. Anyone who wants to be that
        // probe must claim first; this call does not silently promote the
        // caller, or a burst of contenders would all become canaries.
        return {
          allowed: false,
          state: CIRCUIT_STATE.OPEN,
          reason: refusalReason("is open but due for a half-open canary", "claim one before dispatching"),
          refusal: { kind: DISPATCH_REFUSAL.HALF_OPEN_CANARY_IN_FLIGHT, provider, account },
        };
      }
      if (state === CIRCUIT_STATE.OPEN) {
        return {
          allowed: false,
          state,
          reason: refusalReason(
            `stopped dispatching after a permanent ${openedByKind ?? "configuration"} failure`
          ),
          refusal: { kind: DISPATCH_REFUSAL.CIRCUIT_OPEN, provider, account },
        };
      }
      if (canaryOwner !== null && canaryOwner !== owner) {
        return {
          allowed: false,
          state,
          reason: refusalReason("is half-open and another worker holds the canary"),
          refusal: {
            kind: DISPATCH_REFUSAL.HALF_OPEN_CANARY_IN_FLIGHT,
            provider,
            account,
            canary_owner: canaryOwner,
          },
        };
      }
      return { allowed: true, state, reason: null, refusal: null };
    },

    /** Test/diagnostic view. The canary holder is included so "one canary" is observable. */
    snapshot() {
      return {
        key,
        state,
        opened_at: canaryClaimedAtMs !== null && state === CIRCUIT_STATE.HALF_OPEN ? null : iso(openedAtMs),
        opened_by: openedByKind,
        canary_owner: canaryOwner,
        canary_claimed_at: iso(canaryClaimedAtMs),
      };
    },
  };
}

function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * USD amounts are held at micro-dollar resolution.
 *
 * This is not cosmetic. Float addition is not associative at the cent level —
 * measured here, `0.2 + 0.4` is `0.6000000000000001` — so a ledger that stores
 * raw sums compares a total against its cap with an error that can fall on
 * either side of the boundary. Rounding once, on the way in and on the way out,
 * makes "the reservation exactly fits" a fact rather than a coin toss, and makes
 * two runs of the same fixtures report the same number.
 */
const USD_SCALE = 1e6;

/** @param {number} value @returns {number} */
export function roundUsd(value) {
  return Math.round(value * USD_SCALE) / USD_SCALE;
}

/**
 * The in-process spend ledger (R02.5b).
 *
 * A reservation is AUTHORIZED before a call and set against the cap
 * synchronously, so the check and the bookkeeping cannot be separated by an
 * await — which is how two workers both spend the last of a budget. Refusals
 * are RECORDED, not merely returned: an operator needs to see that work was
 * skipped for budget, and a scan that silently stopped is the failure mode this
 * exists to prevent.
 *
 * This is bookkeeping, not accounting. It deliberately does not try to be the
 * durable ledger (see the module header); what it guarantees is that a caller
 * cannot authorize a reservation that would take the total past the cap, and
 * cannot present a refusal as a success.
 *
 * @param {{capUsd: number, now?: () => number}} input
 */
export function createSpendLedger({ capUsd, now = () => Date.now() } = {}) {
  if (!Number.isFinite(capUsd) || capUsd < 0) {
    throw new Error(`createSpendLedger: capUsd must be a finite non-negative number, got ${JSON.stringify(capUsd)}`);
  }
  const reservations = new Map();
  const refusals = [];

  const reservedTotal = () =>
    roundUsd([...reservations.values()].reduce((sum, entry) => sum + (entry.settled_usd ?? entry.reserved_usd), 0));

  return {
    cap_usd: capUsd,

    /**
     * Reserve before dispatch. The refusal path returns the reason and the
     * remaining headroom, and leaves a record.
     *
     * @param {object} input
     * @param {string} input.id the observation/pair this reservation is for
     * @param {number} input.amountUsd
     */
    reserve({ id, amountUsd } = {}) {
      if (!id) throw new Error("createSpendLedger.reserve: an id is required — an unattributable reservation cannot be reconciled");
      if (!Number.isFinite(amountUsd) || amountUsd < 0) {
        throw new Error(`createSpendLedger.reserve: amountUsd must be finite and non-negative, got ${JSON.stringify(amountUsd)}`);
      }
      const amount = roundUsd(amountUsd);
      const already = reservations.get(id);
      if (already) {
        return { authorized: true, id, reserved_usd: already.reserved_usd, remaining_usd: roundUsd(capUsd - reservedTotal()), duplicate: true };
      }
      const committed = reservedTotal();
      const at = iso(now());
      if (roundUsd(committed + amount) > capUsd) {
        const record = {
          id,
          requested_usd: amount,
          committed_usd: committed,
          cap_usd: capUsd,
          reason: DISPATCH_REFUSAL.SPEND_RESERVED,
          at,
        };
        refusals.push(record);
        return { authorized: false, id, reason: record.reason, record, remaining_usd: roundUsd(capUsd - committed) };
      }
      reservations.set(id, { id, reserved_usd: amount, settled_usd: null, at });
      return { authorized: true, id, reserved_usd: amount, remaining_usd: roundUsd(capUsd - reservedTotal()), duplicate: false };
    },

    /**
     * Replace an estimate with what the provider actually reported.
     *
     * `costUsd: null` means the charge is UNKNOWN (a dispatched request whose
     * outcome we never read, R02-21), and it must not be settled as zero: the
     * reservation stays at its estimate, and the entry says why.
     */
    settle({ id, costUsd = null } = {}) {
      const entry = reservations.get(id);
      if (!entry) {
        throw new Error(`createSpendLedger.settle: no reservation for "${id}" — settling an idle id would invent spend`);
      }
      if (costUsd === null) {
        entry.settled_usd = null;
        entry.cost_state = "unknown_billed";
        return { id, cost_usd: null, cost_state: "unknown_billed", reserved_usd: entry.reserved_usd };
      }
      if (!Number.isFinite(costUsd) || costUsd < 0) {
        throw new Error(`createSpendLedger.settle: costUsd must be finite, non-negative, or null, got ${JSON.stringify(costUsd)}`);
      }
      entry.settled_usd = roundUsd(costUsd);
      entry.cost_state = "measured";
      return { id, cost_usd: entry.settled_usd, cost_state: "measured", reserved_usd: entry.reserved_usd };
    },

    /** Hand the reservation back (the call never happened). */
    release({ id } = {}) {
      return { id, released: reservations.delete(id) };
    },

    /** Read-only state for a caller that has to report what it spent and what it refused. */
    state() {
      const committed = reservedTotal();
      return {
        cap_usd: capUsd,
        committed_usd: committed,
        remaining_usd: roundUsd(capUsd - committed),
        reservations: [...reservations.values()].map((entry) => ({ ...entry })),
        refusals: refusals.map((entry) => ({ ...entry })),
      };
    },
  };
}

/**
 * The seam a worker calls before every provider dispatch.
 *
 * It is deliberately the ONLY place that combines the two refusals, because
 * "stopped for budget" and "stopped for a dead credential" must be
 * distinguishable in the same vocabulary a scan records — and because the
 * ordering (circuit, then spend) has to be the same for every caller or one
 * engine will spend against a cap another engine already exhausted.
 *
 * @param {object} input
 * @param {() => number} [input.now]
 * @param {number} [input.cooldownMs]
 * @param {ReturnType<typeof createSpendLedger>|null} [input.spendLedger]
 */
export function createDispatchGate({ now = () => Date.now(), cooldownMs = DEFAULT_COOLDOWN_MS, spendLedger = null } = {}) {
  const breakers = new Map();

  return {
    breakerFor({ provider, account = null } = {}) {
      const key = circuitKey({ provider, account });
      if (!breakers.has(key)) {
        breakers.set(key, createCircuitBreaker({ provider, account, now, cooldownMs }));
      }
      return breakers.get(key);
    },

    /** Record a classification against the breaker for the identity that produced it. */
    recordFailure({ provider, account = null, classification } = {}) {
      return this.breakerFor({ provider, account }).record(classification);
    },

    /** A successful dispatch closes the breaker for that identity, whichever engine it was. */
    recordSuccess({ provider, account = null } = {}) {
      return this.breakerFor({ provider, account }).close();
    },

    /**
     * Authorize one dispatch. Call this BEFORE the request, and treat a refusal
     * as a terminal disposition — it is not an error to retry.
     *
     * @returns {{allowed: boolean, reason: string|null, refusal: object|null,
     *            reservation: object|null, provider: string, account: string|null}}
     */
    authorizeDispatch({ provider, account = null, owner = null, reservation = null } = {}) {
      if (!provider) throw new Error("authorizeDispatch: a provider is required");
      const breaker = this.breakerFor({ provider, account });
      const verdict = breaker.verdict(owner);
      if (!verdict.allowed) {
        return {
          allowed: false,
          reason: verdict.reason,
          refusal: verdict.refusal,
          reservation: null,
          provider,
          account,
        };
      }
      if (spendLedger && reservation) {
        const reserved = spendLedger.reserve(reservation);
        if (!reserved.authorized) {
          return {
            allowed: false,
            reason: `${provider} (account ${account ?? "unidentified"}) was refused a spend reservation for "${
              reserved.id
            }": ${reserved.remaining_usd} USD of the ${spendLedger.cap_usd} USD cap remains`,
            refusal: {
              kind: reserved.reason,
              provider,
              account,
              record: reserved.record,
            },
            reservation: null,
            provider,
            account,
          };
        }
        return {
          allowed: true,
          reason: null,
          refusal: null,
          reservation: reserved,
          provider,
          account,
        };
      }
      return { allowed: true, reason: null, refusal: null, reservation: null, provider, account };
    },
  };
}

/**
 * Which engines share a circuit, so a caller can ask the question that matters
 * for an outage: is this failure about a SHARED account (stop its dependents at
 * once) or about one engine (stop only that one)?
 *
 * Takes dispatch PLANS, because the identity it groups by is the one a plan
 * carries (`circuit_identity`) rather than something re-derived here — the
 * grouping and the dispatch must agree about what "the same account" means, and
 * a second derivation is how they would come to disagree.
 *
 * @param {Array<{engine: string, circuit_identity?: {provider: string, account: string|null}|null}>} plans
 * @returns {Map<string, string[]>} circuit key -> engines that depend on it
 */
export function dependentEnginesByProvider(plans = []) {
  const byProvider = new Map();
  for (const plan of plans) {
    const identity = plan?.circuit_identity;
    if (!identity?.provider) continue;
    const key = circuitKey(identity);
    const engines = byProvider.get(key) ?? [];
    engines.push(plan.engine);
    byProvider.set(key, engines);
  }
  return byProvider;
}

/** Re-exported so a caller does not have to import two modules to ask this. */
export { opensProviderCircuit, PROVIDER_FAILURE };
