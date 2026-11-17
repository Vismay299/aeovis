import { z } from "zod";
import { AppError } from "../../../shared/http/appError.ts";
import {
  requireApprovedPrice,
  type PricingContext,
} from "../../../shared/pricing/pricedActions.ts";
import {
  createContentJob,
  hasActiveContentJobForBrand,
} from "../../db/content.js";
import { startContentJob } from "../../../shared/content/contentWorker.js";
import { keepAlive } from "../../keepAlive.js";
import type { ToolDefinition, ToolHandlerContext } from "../types.ts";

const draftInput = z.strictObject({
  topic: z.string().trim().min(1).max(300),
  brief: z.string().trim().max(8000).default(""),
  format: z.enum(["geo_article", "linkedin_post"]).default("geo_article"),
  maxUsd: z.number().positive().max(1000),
});

const draftOutput = z.looseObject({
  jobId: z.string(),
  status: z.string(),
});

const listInput = z.strictObject({
  limit: z.int().min(1).max(50).default(20),
});

const listOutput = z.looseObject({
  items: z.array(
    z.looseObject({
      id: z.string(),
      title: z.string().nullable(),
      status: z.string(),
      updatedAt: z.string().nullable(),
    }),
  ),
});

type Row = Record<string, any>;
type Admin = ToolHandlerContext["admin"];
type ContentJob = { id: string; status: string };

type ActiveJobCheck = (
  brand: string,
  opts: { playbook: string; query: string },
  deps: { client: unknown },
) => Promise<boolean>;

type CreateJob = (
  job: {
    brand: string;
    playbook: string;
    input: { query: string; brief: string; brand_name: string; url: string };
  },
  deps: { client: unknown },
) => Promise<ContentJob>;

type StartJob = (jobId: string) => Promise<unknown>;
type KeepAlive = (work: () => Promise<unknown> | void, opts?: { label?: string }) => unknown;

const defaultHasActive = hasActiveContentJobForBrand as unknown as ActiveJobCheck;
const defaultCreateJob = createContentJob as unknown as CreateJob;
const defaultStartJob = startContentJob as unknown as StartJob;
const defaultKeepAlive = keepAlive as unknown as KeepAlive;

async function read<T>(query: unknown): Promise<T> {
  const response = (await query) as { data: T; error: unknown };
  if (response.error) throw response.error;
  return response.data;
}

export type ContentDraftDeps = {
  requireApprovedPrice?: typeof requireApprovedPrice;
  hasActiveContentJobForBrand?: ActiveJobCheck;
  createContentJob?: CreateJob;
  startContentJob?: StartJob;
  keepAlive?: KeepAlive;
};

export type ListContentItemsDeps = Record<string, never>;

export function createStartContentDraftTool(
  deps: ContentDraftDeps = {},
): ToolDefinition {
  return {
    name: "start_content_draft",
    description:
      "Start a paid Content Studio draft and return its job. The topic must not already be generating.",
    input: draftInput,
    output: draftOutput,
    handler: async (ctx, raw) => {
      const input = draftInput.parse(raw);
      const hasActiveFn = deps.hasActiveContentJobForBrand ?? defaultHasActive;
      const active = await hasActiveFn(
        ctx.brand.brandKey,
        { playbook: input.format, query: input.topic },
        { client: ctx.admin },
      );
      if (active) {
        throw new AppError(
          409,
          "content_in_progress",
          "This topic is already being generated.",
        );
      }

      const pricingCtx: PricingContext = {
        brandKey: ctx.brand.brandKey,
        admin: ctx.admin,
        env: process.env,
        now: new Date(),
      };

      const approveFn = deps.requireApprovedPrice ?? requireApprovedPrice;
      await approveFn("content.draft.run", pricingCtx, { format: input.format }, input.maxUsd);

      const createFn = deps.createContentJob ?? defaultCreateJob;
      const job = await createFn(
        {
          brand: ctx.brand.brandKey,
          playbook: input.format,
          input: {
            query: input.topic,
            brief: input.brief,
            brand_name: ctx.brand.display_name,
            url: ctx.brand.website,
          },
        },
        { client: ctx.admin },
      );

      const startFn = deps.startContentJob ?? defaultStartJob;
      const keepAliveFn = deps.keepAlive ?? defaultKeepAlive;
      keepAliveFn(() => startFn(job.id), { label: "assistant-content" });

      return draftOutput.parse({ jobId: job.id, status: job.status });
    },
  };
}

export function createListContentItemsTool(
  _deps: ListContentItemsDeps = {},
): ToolDefinition {
  return {
    name: "list_content_items",
    description: "List the most recently updated content items in this workspace.",
    input: listInput,
    output: listOutput,
    handler: async (ctx, raw) => {
      const input = listInput.parse(raw);
      const admin: Admin = ctx.admin;
      const rows = await read<Row[]>(
        admin
          .from("content_items")
          .select("id,title,status,updated_at")
          .eq("brand", ctx.brand.brandKey)
          .order("updated_at", { ascending: false })
          .limit(input.limit),
      );

      return listOutput.parse({
        items: (Array.isArray(rows) ? rows : []).map((row) => ({
          id: String(row.id),
          title: typeof row.title === "string" ? row.title : null,
          status: String(row.status ?? ""),
          updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
        })),
      });
    },
  };
}

export const startContentDraftTool = createStartContentDraftTool();
export const listContentItemsTool = createListContentItemsTool();
