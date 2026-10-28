/**
 * F07 §6.2.8 — the two assistant tool definitions. Own code.
 *
 * F07 only exports them: F22's registry decides when a turn may call one. Both
 * inputs are closed (`z.strictObject`) because a model that invents a field
 * should be corrected, not silently ignored, and both outputs are loose so F22
 * can add metadata without breaking these definitions.
 */

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { projectContextUpdateSchema, projectContextSchema } from "../../shared/project-context.ts";
import {
  applyContextUpdates,
  getProjectContext,
  renderProjectContextMarkdown,
} from "./service.ts";
import type { ProjectContextDeps, WorkspaceBrand } from "./service.ts";

/**
 * What a handler is given. `admin` and `userId` belong to the turn; `deps` is
 * F07's own seam so the tests (and F22, if it wants to reuse a repository) can
 * supply an in-memory store instead of a database.
 */
export type ProjectContextToolContext = {
  admin: SupabaseClient;
  brand: WorkspaceBrand;
  userId: string;
  deps?: ProjectContextDeps;
};

const getInput = z.strictObject({});
const getOutput = z.looseObject({ markdown: z.string(), context: projectContextSchema });
const updateInput = z.strictObject({ updates: z.array(projectContextUpdateSchema).min(1).max(50) });
const updateOutput = z.looseObject({ markdown: z.string() });

export const getProjectContextTool = {
  name: "get_project_context",
  description:
    "Read this workspace's memory: business overview, goal, positioning, writing preferences, custom sections, declared competitors, key pages and the research log. Call before research or writing. Use the research log to avoid buying the same research twice within 90 days.",
  input: getInput,
  output: getOutput,
  handler: async (ctx: ProjectContextToolContext, rawInput?: unknown) => {
    // An empty closed input: `{ brand: "..." }` and friends must be refused.
    getInput.parse(rawInput ?? {});
    const context = await getProjectContext(ctx.admin, ctx.brand, ctx.deps);
    return getOutput.parse({ markdown: renderProjectContextMarkdown(context), context });
  },
};

export const updateProjectContextTool = {
  name: "update_project_context",
  description:
    "Apply 1–50 edits to this workspace's memory in one atomic batch. Saved values are authoritative: only fill what is missing or what the user asked to change.",
  input: updateInput,
  output: updateOutput,
  handler: async (ctx: ProjectContextToolContext, rawInput?: unknown) => {
    const input = updateInput.parse(rawInput ?? {});
    // Assistant writes are recorded as "assistant" with no user id, and
    // competitors it proposes carry source "assistant" (never "manual").
    const context = await applyContextUpdates(ctx.admin, ctx.brand, input.updates, "assistant", null, {
      ...ctx.deps,
      competitorSource: "assistant",
    });
    return updateOutput.parse({ markdown: renderProjectContextMarkdown(context) });
  },
};

export const projectContextTools = [getProjectContextTool, updateProjectContextTool];
