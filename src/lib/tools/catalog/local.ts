import {
  getBusinessProfileTool,
  getBusinessReviewsTool,
  getBusinessUpdatesTool,
  getGoogleBusinessQuestionsTool,
  getLocalRankGridTool,
  getLocalSerpResultsTool,
  listBusinessCategoriesTool,
  searchLocalBusinessesTool,
} from "../../local/tools.ts";
import { defineRegistration, type ToolRegistration } from "../types.ts";
import {
  actionQuoteInput,
  paidAnnotations,
  readAnnotations,
} from "./quote.ts";

const link = () => ({ path: "/portal/local", label: "Local" });
const NEAR = { latitude: 40.7128, longitude: -74.006, radiusKm: 10 };
const CENTER = { latitude: 40.7128, longitude: -74.006 };
const BUSINESS_ID = "6a1f0000-0000-4000-8000-000000000001";
const GRID_ID = "9e8d0000-0000-4000-8000-000000000002";

function fetchExample(kind: string, depth: number) {
  return {
    id: "9e8d0000-0000-4000-8000-000000000003",
    kind,
    status: "completed",
    businessId: BUSINESS_ID,
    params: { depth },
    totals: null,
    items: [],
    itemCount: 0,
    reused: false,
    error: null,
    createdAt: "2026-10-20T10:12:04.000Z",
    completedAt: "2026-10-20T10:12:10.000Z",
    pollAfterSeconds: null,
  };
}

export const registrations: ToolRegistration[] = [
  defineRegistration({
    def: searchLocalBusinessesTool as never,
    area: "local",
    feature: "local_seo",
    effect: "paid",
    approval: (_ctx, input) => ({
      kind: "price",
      action: "local.listings.search",
      quoteInput: actionQuoteInput("local.listings.search", input),
      label: "Search nearby businesses",
    }),
    annotations: paidAnnotations(),
    summarize: (output: any) => (output?.businesses?.length ?? 0) + " businesses.",
    link,
    example: {
      input: { near: NEAR, query: "coffee shop", maxUsd: 0.2 },
      output: {
        businesses: [],
        cached: false,
        fetchedAt: "2026-10-20T10:12:04.000Z",
      },
    },
  }),
  defineRegistration({
    def: getLocalSerpResultsTool as never,
    area: "local",
    feature: "local_seo",
    effect: "paid",
    approval: (_ctx, input) => ({
      kind: "price",
      action: "local.serp.search",
      quoteInput: actionQuoteInput("local.serp.search", input),
      label: "Local results for “" + String(input.keyword ?? "") + "”",
    }),
    annotations: paidAnnotations(),
    summarize: (output: any, input: any) =>
      (output?.results?.length ?? 0) +
      " local results for “" +
      String(input?.keyword ?? "") +
      "”.",
    link,
    example: {
      input: {
        keyword: "coffee shop",
        near: { latitude: 40.7128, longitude: -74.006 },
        maxUsd: 0.1,
      },
      output: {
        results: [],
        ownRank: null,
        cached: false,
        fetchedAt: "2026-10-20T10:12:04.000Z",
      },
    },
  }),
  defineRegistration({
    def: getLocalRankGridTool as never,
    area: "local",
    feature: "local_seo",
    effect: "paid",
    approval: (_ctx, input) =>
      input.gridId
        ? { kind: "none" }
        : {
            kind: "price",
            action: "local.grid.run",
            quoteInput: actionQuoteInput("local.grid.run", input),
            label:
              "Run a " +
              String(input.gridSize ?? 3) +
              "×" +
              String(input.gridSize ?? 3) +
              " local rank grid",
          },
    annotations: paidAnnotations(),
    summarize: (output: any) => {
      const size = output?.gridSize ?? 3;
      const ranked = output?.summary?.pointsFound ?? 0;
      const points = output?.summary?.pointsSearched ?? output?.pointsTotal ?? 0;
      return size + "×" + size + " grid: ranked at " + ranked + " of " + points + " points.";
    },
    link,
    example: {
      input: {
        keyword: "coffee shop",
        center: CENTER,
        target: { placeId: "example-place-id" },
        maxUsd: 0.5,
      },
      output: {
        id: GRID_ID,
        status: "completed",
        keyword: "coffee shop",
        center: CENTER,
        gridSize: 3,
        spacingKm: 2,
        zoom: 12,
        device: "mobile",
        pointsReady: 9,
        pointsTotal: 9,
        points: null,
        summary: {
          pointsSearched: 9,
          pointsFound: 7,
          failed: 0,
          averageRank: 4.2,
          top3Count: 2,
          top10Count: 5,
        },
        matched: null,
        reused: false,
        error: null,
        createdAt: "2026-10-20T10:12:04.000Z",
        pollAfterSeconds: null,
      },
    },
  }),
  defineRegistration({
    def: getBusinessProfileTool as never,
    area: "local",
    feature: "local_seo",
    effect: "paid",
    approval: (_ctx, input) => ({
      kind: "price",
      action: "local.profile.lookup",
      quoteInput: actionQuoteInput("local.profile.lookup", input),
      label: "Look up a business profile",
    }),
    annotations: paidAnnotations(),
    summarize: (output: any) =>
      "Profile for " +
      String(
        output?.profile?.title ??
          output?.profile?.name ??
          "the business",
      ) +
      ".",
    link,
    example: {
      input: {
        identifier: { businessName: "Acme Coffee" },
        maxUsd: 0.1,
      },
      output: { profile: null, businessId: null },
    },
  }),
  defineRegistration({
    def: getBusinessReviewsTool as never,
    area: "local",
    feature: "local_seo",
    effect: "paid",
    approval: (_ctx, input) =>
      input.fetchId
        ? { kind: "none" }
        : {
            kind: "price",
            action: "local.reviews.collect",
            quoteInput: actionQuoteInput("local.reviews.collect", input),
            label: "Collect reviews for a business",
          },
    annotations: paidAnnotations(),
    summarize: (output: any) =>
      (output?.itemCount ?? 0) +
      " reviews" +
      (output?.status === "processing" ? " (still collecting)" : "") +
      ".",
    link,
    example: {
      input: { businessId: BUSINESS_ID, depth: 20, maxUsd: 0.1 },
      output: fetchExample("reviews", 20),
    },
  }),
  defineRegistration({
    def: getBusinessUpdatesTool as never,
    area: "local",
    feature: "local_seo",
    effect: "paid",
    approval: (_ctx, input) =>
      input.fetchId
        ? { kind: "none" }
        : {
            kind: "price",
            action: "local.updates.collect",
            quoteInput: actionQuoteInput("local.updates.collect", input),
            label: "Collect profile posts for a business",
          },
    annotations: paidAnnotations(),
    summarize: (output: any) => (output?.itemCount ?? 0) + " profile posts.",
    link,
    example: {
      input: { businessId: BUSINESS_ID, depth: 10, maxUsd: 0.1 },
      output: fetchExample("updates", 10),
    },
  }),
  defineRegistration({
    def: getGoogleBusinessQuestionsTool as never,
    area: "local",
    feature: "local_seo",
    effect: "paid",
    // F22 §6.2.5: a fetchId is a free resume, so it never opens a price card.
    approval: (_ctx, input) =>
      input.fetchId
        ? { kind: "none" }
        : {
            kind: "price",
            action: "local.questions.collect",
            quoteInput: actionQuoteInput("local.questions.collect", input),
            label: "Collect questions and answers for a business",
          },
    annotations: paidAnnotations(),
    summarize: (output: any) => (output?.itemCount ?? 0) + " questions and answers.",
    link,
    example: {
      input: { businessId: BUSINESS_ID, depth: 20, maxUsd: 0.1 },
      output: fetchExample("questions", 20),
    },
  }),
  defineRegistration({
    def: listBusinessCategoriesTool as never,
    area: "local",
    feature: "local_seo",
    effect: "read",
    approval: () => ({ kind: "none" }),
    annotations: readAnnotations(),
    summarize: (output: any) =>
      (output?.categories?.length ?? 0) + " categories.",
    example: {
      input: {},
      output: { categories: [], total: 0 },
    },
  }),
];
