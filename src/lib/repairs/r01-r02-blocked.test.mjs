import test from "node:test";

/**
 * R01/R02 — the cases this pass does NOT execute, registered so that a green
 * run cannot be read as all passed.
 *
 * R03, R04 and R05 register their blocked cases alongside their passing ones. R01
 * and R02 did not, and the asymmetry was load-bearing: `node --test` over the
 * offline files showed eight skips from R03/R04 and none from R01/R02, so the
 * one repair with the most database-level cases looked fully covered. A skip
 * nobody wrote down is indistinguishable from evidence.
 *
 * Every reason is the backlog's own level requirement. D needs a real PostgreSQL
 * with the migrations applied and committed transactions — an in-memory store
 * cannot establish a conditional-update claim or a crash boundary. B needs the
 * app in a browser. L needs a funded provider call, and this pass is not
 * authorised to spend: no paid live call is made anywhere in this change set.
 *
 * The offline halves of R02-19 and R02-20 DO run, and deliberately do not carry
 * those ids in their names — passing the policy arithmetic is not passing the
 * durable case, and a test named for the case would report exactly that pass.
 */

const BLOCKED = [
  // R01 — the readiness repair. Its U/I cases (01-12, 14) run and pass.
  [
    "R01-13",
    "two concurrent canary dispatchers claim one scheduled canary — needs real PostgreSQL (D): the claim is a transactional reservation, and a stub store cannot establish it",
  ],
  [
    "R01-15",
    "the operator status surface shows canary age, affected surface and recovery action — needs the real app in a browser (B)",
  ],
  [
    "R01-16",
    "one current bounded canary per offered surface — a live provider call (L); no paid call is made in this pass",
  ],

  // R02 — the attempts/leases/circuits repair. Its U/I cases (01-06, 17, 18, 21) run and pass.
  [
    "R02-07",
    "two workers race one due observation and exactly one lease wins — the whole point is committed concurrent transactions (D)",
  ],
  [
    "R02-08",
    "twenty due observations claimed by concurrent batches, none claimed twice — committed transactions (D)",
  ],
  [
    "R02-09",
    "an active lease cannot be reclaimed before expiry — needs the real lease row and its generation (D)",
  ],
  [
    "R02-10",
    "a new generation owns completion after lease expiry and a stale owner cannot overwrite it — fenced writes need real storage (D)",
  ],
  [
    "R02-11",
    "the worker is killed before a result commit so dispatch-unknown survives — needs a process killed at a real commit boundary (D)",
  ],
  [
    "R02-12",
    "a retried ambiguous dispatch reuses the provider idempotency key — needs the durable attempt row to compare against it (D)",
  ],
  [
    "R02-13",
    "an ambiguous dispatch with no provider idempotency support stays flagged ambiguous — needs the durable attempt row (D)",
  ],
  [
    "R02-14",
    "a committed attempt is not re-requested on resume — needs persisted results to resume from (D)",
  ],
  [
    "R02-15",
    "only due failed pairs retry after provider recovery — needs the persisted failure rows (D)",
  ],
  [
    "R02-16",
    "the same attempt delivered twice produces one durable effect — needs a real uniqueness constraint (D)",
  ],
  [
    "R02-19",
    "multiple half-open contenders produce exactly one canary against durable circuit state — the offline half of this decision runs and passes; the durable claim is what remains (D)",
  ],
  [
    "R02-20",
    "workers near a shared spend ceiling race their reservations and stay inside the cap — the offline half runs and passes; the concurrent race against committed rows is what remains (D)",
  ],
  [
    "R02-22",
    "tenant A cannot inspect or mutate tenant B's attempts or circuit details — needs real RLS under customer roles (D)",
  ],
  [
    "R02-23",
    "a crash after a batch result commit leaves the committed rows and no duplicate final observation — needs real storage (D)",
  ],
  [
    "R02-24",
    "the execution detail surface agrees with storage on attempt count, disposition and cost uncertainty — needs the app in a browser (B)",
  ],
];

for (const [caseId, reason] of BLOCKED) {
  test(`${caseId} — BLOCKED: ${reason}`, { skip: reason }, () => {});
}
