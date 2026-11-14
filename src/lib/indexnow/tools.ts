import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CustomerBrand } from "../workspace/requireWorkspace.ts";
import { submitUrls } from "./submit.ts";

export type SubmitIndexNowUrlsToolContext = {
  admin: SupabaseClient;
  brand: CustomerBrand;
  userId: string;
  deps?: {
    submitUrls?: typeof submitUrls;
  };
};

const submitIndexNowUrlsInput = z.strictObject({
  urls: z.array(z.string().max(2048)).min(1).max(10000),
});

const hostResultSchema = z.looseObject({
  host: z.string(),
  urlCount: z.number(),
  status: z.enum(["submitted", "failed"]),
  engine: z.enum(["bing", "yandex", "yep"]).nullable(),
  httpStatus: z.number().nullable(),
  reason: z.string().nullable(),
  message: z.string(),
});

const skippedUrlSchema = z.looseObject({
  url: z.string(),
  reason: z.enum(["off_site", "invalid", "recently_submitted"]),
});

const submitIndexNowUrlsOutput = z.looseObject({
  key: z.string(),
  keyCreated: z.boolean(),
  hosts: z.array(hostResultSchema),
  skipped: z.array(skippedUrlSchema),
});

export const submitIndexNowUrlsTool = {
  name: "submit_indexnow_urls",
  description:
    "Tells Bing, Yandex, Seznam, Naver, Yep and other IndexNow search engines that pages on this workspace's website changed, so they recrawl them sooner. Google does not use IndexNow. Submit only new, updated, redirected or removed pages, not the whole site. The site must host the workspace key file at the root of each host. URLs outside the website are skipped. Free.",
  input: submitIndexNowUrlsInput,
  output: submitIndexNowUrlsOutput,
  handler: async (ctx: SubmitIndexNowUrlsToolContext, rawInput?: unknown) => {
    const input = submitIndexNowUrlsInput.parse(rawInput ?? {});
    const requestId = crypto.randomUUID();
    const submit = ctx.deps?.submitUrls ?? submitUrls;
    const result = await submit(
      ctx.admin,
      { brandKey: ctx.brand.brandKey, brand: ctx.brand, user: { id: ctx.userId } },
      { urls: input.urls, source: "tool", requestId },
    );
    return submitIndexNowUrlsOutput.parse(result);
  },
};

export const indexnowTools = [submitIndexNowUrlsTool];
