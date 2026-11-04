/**
 * F03 §6.2 — the cost response shapes, for the UI.
 *
 * Shared code cannot import `src/lib/`, so this file only re-exports the
 * server module's types. `export type` is erased at compile time, so nothing
 * from `src/lib/` reaches the client bundle.
 */

export type { AnswerCost, CostSource, ScanCost } from "../lib/costs/types.ts";
export type { WorkspaceUsage } from "../lib/costs/usage.ts";
export type { OperatorCosts } from "../lib/costs/ops.ts";
