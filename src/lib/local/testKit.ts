// Test support for the F17 services and routes: a workspace fixture, F01 memory
// spend with metered business and serp clients whose provider calls are faked,
// a memory provider cache and a fake clock. Not imported by production code.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CacheRow, CacheStore } from "../cache/store.ts";
import {
  createBusinessClient,
  fetchBusinessListingsSearch,
  fetchMyBusinessInfo,
  fetchQuestionsAnswers,
  postGoogleReviewsTask,
  postMyBusinessUpdatesTask,
  type BusinessClient,
} from "../providers/dataforseo/business.ts";
import { createDataforseoClient, meter } from "../providers/dataforseo/client.ts";
import { createMemoryStore, type MemorySpendStore } from "../spend/memoryStore.ts";
import { createMemoryLocalStore, type MemoryLocalStore } from "./memoryStore.ts";
import type { LocalDeps } from "./store.ts";

export const BRAND = "offcult.example";
export const USER = { id: "11111111-1111-4111-8111-111111111111", email: "owner@offcult.example" };

export function makeWs(brandKey = BRAND) {
  return {
    user: USER,
    brandKey,
    role: "owner" as const,
    admin: {} as never,
    brand: {
      brandKey,
      role: "owner" as const,
      display_name: "Offcult",
      website: `https://www.${brandKey}`,
      website_host: `www.${brandKey}`,
      aliases: [],
      is_active: true,
    },
  };
}

export function fixture(name: string): any {
  const url = new URL(`../../../tests/fixtures/f17/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}

export function fixtureResult(name: string): any {
  return fixture(name).tasks[0].result[0];
}

export function memoryCache(): CacheStore {
  const map = new Map<string, CacheRow>();
  return {
    async read(key) {
      return map.get(key) ?? null;
    },
    async write(row) {
      map.set(row.key, { ...row });
    },
    async readBody() {
      return null;
    },
    async writeBody() {},
    async removeBodies() {},
    async pruneExpired() {
      return { deleted: 0, paths: [] };
    },
  };
}

export type FakeClock = { now: () => number; advance: (ms: number) => void; sleep: (ms: number) => Promise<void>; slept: number[] };

export function fakeClock(start = Date.parse("2026-11-10T12:00:00.000Z")): FakeClock {
  let t = start;
  const slept: number[] = [];
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    async sleep(ms) {
      slept.push(ms);
      t += ms;
    },
    slept,
  };
}

type BusinessResponder = (input: any) => { data: unknown; costUsd?: number } | Promise<{ data: unknown; costUsd?: number }>;

export type SpendHarness = {
  spend: MemorySpendStore;
  /** Metered business client over F01 memory spend; provider calls are the supplied responders. */
  business: BusinessClient;
  /** DataForSEO client whose local SERP calls are the supplied responders. */
  serp: ReturnType<typeof createDataforseoClient>["serp"];
  calls: Record<string, any[]>;
};

const LOCAL_FEATURES = ["local.business", "local.reviews", "local.serp", "local.grid"];

export function spendHarness(
  responders: {
    myBusinessInfo?: BusinessResponder;
    businessListings?: BusinessResponder;
    questionsAnswers?: BusinessResponder;
    reviewsTaskPost?: BusinessResponder;
    updatesTaskPost?: BusinessResponder;
    localSerp?: BusinessResponder;
    localTaskPost?: BusinessResponder;
  },
  opts: { enabled?: boolean } = {},
): SpendHarness {
  const spend = createMemoryStore({
    controls: Object.fromEntries(
      LOCAL_FEATURES.map((feature) => [
        feature,
        { enabled: opts.enabled ?? true, mode: "all" as const, brandAllowlist: [], dailyCapUsd: null, maxCallUsd: null },
      ]),
    ),
  });
  const calls: Record<string, any[]> = {};
  const wrap = (name: keyof typeof responders) => async (input: any) => {
    (calls[name] ??= []).push(input);
    const responder = responders[name];
    if (!responder) throw new Error(`no responder for ${name}`);
    const r = await responder(input);
    return { data: r.data, billing: { costUsd: r.costUsd ?? 0.001, path: ["v3", "business_data", name] } };
  };
  const names = new Map<unknown, keyof typeof responders>([
    [fetchMyBusinessInfo, "myBusinessInfo"],
    [fetchBusinessListingsSearch, "businessListings"],
    [fetchQuestionsAnswers, "questionsAnswers"],
    [postGoogleReviewsTask, "reviewsTaskPost"],
    [postMyBusinessUpdatesTask, "updatesTaskPost"],
  ]);
  const business = createBusinessClient({
    meter: ((fetcher: unknown, estimate: (i: any) => number, feature: any) =>
      meter(wrap(names.get(fetcher) as keyof typeof responders) as any, estimate, feature, {
        spendDeps: { store: spend },
      })) as any,
  });
  const serp = createDataforseoClient({
    spendDeps: { store: spend },
    fetchers: {
      fetchLocalSerp: wrap("localSerp") as any,
      postLocalSerpTasks: wrap("localTaskPost") as any,
    },
  }).serp;
  return { spend, business, serp, calls };
}

export type LocalKit = {
  store: MemoryLocalStore;
  clock: FakeClock;
  deps: LocalDeps;
  harness: SpendHarness;
  logs: string[];
  research: Array<{ kind: string; researchKey?: string; summary: string }>;
};

/** One-stop test fixture: memory store, fake clock, memory cache, spend harness and a research recorder. */
export function localKit(
  responders: Parameters<typeof spendHarness>[0] = {},
  extra: Partial<LocalDeps> = {},
  opts: { enabled?: boolean } = {},
): LocalKit {
  const clock = fakeClock();
  const store = createMemoryLocalStore({ now: clock.now });
  const harness = spendHarness(responders, opts);
  const logs: string[] = [];
  const research: LocalKit["research"] = [];
  const deps: LocalDeps = {
    store,
    business: harness.business,
    serp: harness.serp,
    cacheDeps: { store: memoryCache(), now: clock.now },
    now: clock.now,
    sleep: clock.sleep,
    log: (line) => logs.push(line),
    appendResearch: async (_admin, input) => {
      research.push({ kind: input.kind, researchKey: input.researchKey, summary: input.summary });
    },
    ...extra,
  };
  return { store, clock, deps, harness, logs, research };
}
