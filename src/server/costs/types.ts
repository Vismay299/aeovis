/**
 * F03 §6.2 — the shared cost response shapes.
 *
 * `src/shared/costs.ts` re-exports them for the UI, which cannot import from
 * `src/server/`; the shapes live here so there is exactly one copy.
 */

/** Where a ledger row's amount came from. */
export type CostSource = "provider_reported" | "price_table" | "reservation" | "none";

/** What one answer (one observation) cost, joined by `observation_id`. */
export type AnswerCost = {
  observationId: string;
  engine: string;
  attempts: number;
  knownUsd: number;
  unknownAttempts: number;
  reservedUnknownUsd: number;
  /** `null` while any attempt's cost is unknown: a partial number is not a number. */
  usd: number | null;
};

/** What one scan cost, read live from the attempt ledger. */
export type ScanCost = {
  state: "final" | "running" | "unavailable";
  jobId: string | null;
  answers: number;
  attempts: number;
  knownUsd: number;
  unknownAttempts: number;
  reservedUnknownUsd: number;
  totalAccountedUsd: number;
  perAnswerUsd: number | null;
  byEngine: {
    engine: string;
    label: string;
    answers: number;
    attempts: number;
    knownUsd: number;
    unknownAttempts: number;
    perAnswerUsd: number | null;
  }[];
  /** The open scan hold's estimate, while the scan still runs. */
  heldUsd: number | null;
};
