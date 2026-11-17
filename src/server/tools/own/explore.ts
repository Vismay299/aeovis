import { z } from "zod";
import { exploreRunInputSchema } from "../../../shared/explore.ts";
import {
  startExploreRun,
  getExploreRun,
  type ExploreRunView,
  type ExploreServiceDeps,
} from "../../explore/service.ts";
import type { ToolDefinition } from "../types.ts";
import { toWorkspace } from "./workspace.ts";

export const exploreQuestionInput = exploreRunInputSchema
  .omit({ brand_key: true, maxUsd: true })
  .extend({ maxUsd: z.number().positive().max(1000) });

const exploreQuestionOutput = z.looseObject({
  runId: z.string(),
  status: z.string(),
  pollAfterSeconds: z.number().nullable(),
});

const exploreRunInput = z.strictObject({
  runId: z.uuid(),
});

const exploreRunOutput = z.looseObject({
  runId: z.string(),
  status: z.string(),
  pollAfterSeconds: z.number().nullable(),
  results: z.array(z.looseObject({ status: z.string() })),
  completedModels: z.number(),
});

export type ExploreQuestionDeps = {
  startExploreRun?: typeof startExploreRun;
  service?: ExploreServiceDeps;
};

export type GetExploreRunDeps = {
  getExploreRun?: typeof getExploreRun;
  service?: ExploreServiceDeps;
};

export function createExploreQuestionTool(
  deps: ExploreQuestionDeps = {},
): ToolDefinition {
  return {
    name: "explore_question",
    description:
      "Ask one buyer question to up to three answer engines and start a paid Prompt Explorer run.",
    input: exploreQuestionInput,
    output: exploreQuestionOutput,
    handler: async (ctx, raw) => {
      const input = exploreQuestionInput.parse(raw);
      const startFn = deps.startExploreRun ?? startExploreRun;

      // F11 reads the approved maximum from the body, not from a separate
      // argument, so it must travel with the other explore fields.
      const result = await startFn(
        ctx.admin,
        {
          brandKey: ctx.brand.brandKey,
          userId: ctx.userId,
          body: input,
        },
        deps.service,
      );

      return exploreQuestionOutput.parse({
        runId: result.runId,
        status: result.status,
        pollAfterSeconds: result.pollAfterSeconds,
      });
    },
  };
}

export function createGetExploreRunTool(
  deps: GetExploreRunDeps = {},
): ToolDefinition {
  return {
    name: "get_explore_run",
    description: "Read the status and answers of a Prompt Explorer run.",
    input: exploreRunInput,
    output: exploreRunOutput,
    handler: async (ctx, raw) => {
      const input = exploreRunInput.parse(raw);
      const getFn = deps.getExploreRun ?? getExploreRun;
      const ws = toWorkspace(ctx);
      const view: ExploreRunView = await getFn(
        ws.admin,
        ws.brandKey,
        input.runId,
        deps.service,
      );

      return exploreRunOutput.parse({
        ...view,
        completedModels: view.results.length,
      });
    },
  };
}

export const exploreQuestionTool = createExploreQuestionTool();
export const getExploreRunTool = createGetExploreRunTool();
