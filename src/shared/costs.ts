/**
 * F03 §6.2 — the cost response shapes, for the UI.
 *
 * Shared code cannot import `src/server/`, so this file only re-exports the
 * server module's types. `export type` is erased at compile time, so nothing
 * from `src/server/` reaches the client bundle.
 */

export type { AnswerCost, CostSource, ScanCost } from "../server/costs/types.ts";
export type { WorkspaceUsage } from "../server/costs/usage.ts";
export type { OperatorCosts } from "../server/costs/ops.ts";
