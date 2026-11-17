import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runQuestionSetup } from "./research.ts";
import type { SetupPayload } from "./schemas.ts";
import type { JobContext, StepOptions } from "../../jobs/types.ts";
import { AppError } from "../../../shared/http/appError.ts";
import { estimateQuestionLlmUsd, QUESTIONS_LLM_BOUNDS } from "./prompts.ts";
import { dataforseoPricing } from "../../../shared/pricing/dataforseo.ts";
import { fromMicros, toMicros } from "../../../shared/spend/money.ts";
import { AmbiguousCallError } from "../../../shared/spend/errors.ts";
import { promptgenCandidates } from "./promptgenSource.ts";

function createMockContext(payload: SetupPayload): JobContext<SetupPayload> & {
  stepsRun: Array<{ name: string; opts: StepOptions }>;
  progressCalls: Array<{ done: number; total: number; label?: string }>;
} {
  const stepsRun: Array<{ name: string; opts: StepOptions }> = [];
  const progressCalls: Array<{ done: number; total: number; label?: string }> = [];

  return {
    jobId: "00000000-0000-0000-0000-000000000001",
    brandKey: payload.brandKey,
    payload,
    trigger: "manual",
    stepsRun,
    progressCalls,
    step: {
      async do<T>(name: string, opts: StepOptions, fn: () => Promise<T>): Promise<T> {
        stepsRun.push({ name, opts });
        return await fn();
      },
      async sleep(_name: string, _seconds: number): Promise<void> {},
    },
    async progress(done: number, total: number, label?: string): Promise<void> {
      progressCalls.push({ done, total, label });
    },
  };
}

function createMockDeps(overrides: any = {}) {
  const mockRepo = {
    listSections: async () => overrides.sections ?? [],
    listCompetitors: async () => overrides.competitors ?? [],
    listKeyPages: async () => [],
    listResearchLog: async () => [],
    applyOps: async () => {},
  };

  const mockAdmin: any = {
    from(table: string) {
      const rows = table === "spend_ledger" ? overrides.spendLedgerRows ?? [] : overrides.questions ?? [];
      return {
        select() {
          const chain: any = {
            eq() {
              return chain;
            },
            order() {
              return chain;
            },
            data: rows,
            error: null,
            async maybeSingle() {
              return { data: null, error: null };
            },
            then(resolve: any) {
              return Promise.resolve({ data: rows, error: null }).then(resolve);
            },
          };
          return chain;
        },
      };
    },
    rpc() {
      return Promise.resolve({ data: null, error: null });
    },
  };

  return {
    admin: mockAdmin,
    repo: mockRepo as any,
    discoverSiteUrls: async (root: string) => [root, `${root.replace(/\/$/, "")}/oversized`],
    readPagesFree: async (urls: string[]) => ({
      pages: urls.map((u) => ({
        url: u,
        title: "Page Title",
        content: "Offcult and competitor streetwear catalog.",
      })),
      failed: [],
    }),
    readPageFirecrawl: async () => ({ page: null, billed: false }),
    appendResearch: async () => {},
    model: "openai/gpt-4o-mini",
    env: { QUESTION_SETUP_PROMPTGEN: "off" },
    ...overrides,
  };
}

describe("questions.setup job runner (F08-AC-13, F08-AC-14)", () => {
  const basePayload: SetupPayload = {
    brandKey: "offcult.in",
    approvedMaxUsd: 1.0,
    requestedBy: "00000000-0000-0000-0000-000000000099",
    website: "https://offcult.in",
    ownHost: "offcult.in",
    displayName: "Offcult",
    market: { country: "in", language: "en" },
  };

  const syntheticDraft = {
    topics: [
      {
        name: "Streetwear",
        questions: [
          "Where to buy good streetwear in India?",
          "How to style oversized streetwear tees?",
          "What is the best oversized t-shirt brand in India?",
          "Are heavyweight graphic tees good for summer?",
          "Which streetwear brands use 100% French terry cotton?",
        ],
      },
      {
        name: "Anime Tees",
        questions: [
          "Where can I find licensed anime tees online?",
          "Which brands have oversized anime backprints in India?",
          "How do anime graphic tees fit?",
          "Best oversized anime hoodies and t-shirts?",
          "How to wash anime graphic printed tees?",
        ],
      },
      {
        name: "Sizing & Fit",
        questions: [
          "Should I size down for oversized tees?",
          "What is the difference between boxy fit and oversized fit?",
          "What shoulder drop is typical for oversized tees?",
          "How do unisex streetwear sizes work?",
          "Best streetwear fit for lean body types?",
        ],
      },
      {
        name: "Heavyweight Cotton",
        questions: [
          "What GSM is ideal for heavyweight tees?",
          "Is 240 GSM cotton good for oversized t-shirts?",
          "Do 100% cotton streetwear tees shrink after washing?",
          "Difference between combed cotton and French terry?",
          "Why do streetwear brands prefer heavy cotton?",
        ],
      },
      {
        name: "Care & Styling",
        questions: [
          "How to prevent graphic prints from cracking?",
          "Can you iron over screen-printed streetwear tees?",
          "How to style baggy jeans with an oversized tee?",
          "What footwear goes best with streetwear oversized tees?",
          "Are drop shoulder tees machine washable?",
        ],
      },
    ],
    suggestedKeywords: ["oversized tees", "graphic streetwear", "anime t-shirts"],
    persona: "Young Indian shoppers looking for premium anime and streetwear clothing online",
    overview: "Offcult is an Indian direct-to-consumer streetwear brand specializing in heavyweight oversized tees and anime graphics.",
    searchQueries: ["oversized streetwear t-shirts india", "anime oversized tees brands"],
  };

  it("completes happy path end-to-end with review result", async () => {
    const ctx = createMockContext(basePayload);
    let researchLog: any;

    const mockDeps = createMockDeps({
      env: { QUESTION_SETUP_PROMPTGEN: "on" },
      spendLedgerRows: [{ accounted_usd: "0.03" }, { accounted_usd: "0.02" }],
      appendResearch: async (_admin: any, input: any) => {
        researchLog = input;
      },
      llmObject: async (opts: any) => {
        if (opts.system.includes("Fill only the missing")) {
          return { object: syntheticDraft, usd: 0.01 };
        }
        if (opts.system.includes("Choose candidate competitors")) {
          return { object: { domains: ["bewakoof.com", "thesouledstore.com"] }, usd: 0.02 };
        }
        if (opts.system.includes("Verify competitors")) {
          return {
            object: {
              competitors: [
                {
                  name: "Bewakoof",
                  domain: "bewakoof.com",
                  notes: "Sells oversized anime and graphic tees online.",
                  sourceUrl: "https://bewakoof.com/oversized",
                },
              ],
            },
            usd: 0.03,
          };
        }
        throw new Error(`Unexpected system prompt: ${opts.system}`);
      },
      dataforseoClient: {
        serp: {
          live: async () => [
            {
              type: "organic",
              title: "Bewakoof Oversized Tees",
              url: "https://bewakoof.com/oversized",
              description: "Shop cool streetwear tees online in India.",
            },
          ],
        },
      } as any,
      promptgenCandidates: async (promptgenContext: any) => {
        promptgenContext.onLlmSpend(0.04);
        return [
          {
            text: "What are the best streetwear clothing brands in India?",
            topic: "Streetwear",
            source: "promptgen",
          },
        ];
      },
    });

    const res = await runQuestionSetup(ctx, mockDeps as any);
    assert.ok(res.result);
    const review = (res.result as any).review;
    assert.strictEqual(review.version, 1);
    assert.strictEqual(review.overview.preserved, false);
    assert.ok(review.overview.text.includes("Offcult"));
    assert.strictEqual(review.competitors.preserved, false);
    assert.strictEqual(review.competitors.items.length, 1);
    assert.strictEqual(review.competitors.items[0].domain, "bewakoof.com");
    assert.ok(review.candidates.length > 0);
    assert.ok(review.topics.length > 0);
    assert.ok(review.suggestedKeywords.length > 0);
    assert.ok(Buffer.byteLength(JSON.stringify(review), "utf8") < 60_000);
    assert.equal(researchLog.kind, "questions.setup");
    assert.equal(researchLog.researchKey, "offcult.in");
    assert.equal(researchLog.jobId, ctx.jobId);
    assert.equal(researchLog.spendUsd, 0.15);

    // Check steps run
    const stepNames = ctx.stepsRun.map((s) => s.name);
    assert.ok(stepNames.includes("load"));
    assert.ok(stepNames.includes("site-free"));
    assert.ok(stepNames.includes("draft"));
    assert.ok(stepNames.includes("serp-1"));
    assert.ok(stepNames.includes("pick"));
    assert.ok(stepNames.includes("verify"));
    assert.ok(stepNames.includes("promptgen"));
    assert.ok(stepNames.includes("assemble"));
    assert.ok(stepNames.includes("log"));
    const paidSteps = ["draft", "serp-1", "serp-2", "pick", "verify", "promptgen"];
    for (const name of paidSteps) {
      const step = ctx.stepsRun.find((entry) => entry.name === name);
      assert.ok(step, `${name} should run`);
      assert.equal(step.opts.billed, true, `${name} must be billed`);
      assert.equal(step.opts.retries, 0, `${name} must not retry`);
    }
    assert.deepEqual(ctx.progressCalls, [
      { done: 1, total: 5, label: "Reading your website" },
      { done: 2, total: 5, label: "Drafting questions" },
      { done: 3, total: 5, label: "Finding competitors" },
      { done: 4, total: 5, label: "Adding search-grounded questions" },
      { done: 5, total: 5, label: "Preparing your review" },
    ]);
  });

  it("keeps LLM charges in the budget and the log when a resumed run replays memoized steps", async () => {
    // A finished step returns its memoized output on a later invocation without
    // re-running its body, so spend must come from step outputs, not side effects.
    const memo = new Map<string, unknown>();
    function memoContext(replay: boolean) {
      const ctx = createMockContext(basePayload);
      ctx.step.do = async function <T>(name: string, opts: StepOptions, fn: () => Promise<T>): Promise<T> {
        ctx.stepsRun.push({ name, opts });
        if (replay && memo.has(name)) return memo.get(name) as T;
        const out = await fn();
        memo.set(name, out);
        return out;
      };
      return ctx;
    }
    const logs: any[] = [];
    let llmCalls = 0;
    const deps = () =>
      createMockDeps({
        env: { QUESTION_SETUP_PROMPTGEN: "on" },
        spendLedgerRows: [{ accounted_usd: "0.03" }, { accounted_usd: "0.02" }],
        appendResearch: async (_admin: any, input: any) => {
          logs.push(input);
        },
        llmObject: async (opts: any) => {
          llmCalls += 1;
          if (opts.system.includes("Fill only the missing")) return { object: syntheticDraft, usd: 0.01 };
          if (opts.system.includes("Choose candidate competitors")) {
            return { object: { domains: ["bewakoof.com"] }, usd: 0.02 };
          }
          if (opts.system.includes("Verify competitors")) {
            return {
              object: {
                competitors: [
                  {
                    name: "Bewakoof",
                    domain: "bewakoof.com",
                    notes: "Sells oversized anime and graphic tees online.",
                    sourceUrl: "https://bewakoof.com/oversized",
                  },
                ],
              },
              usd: 0.03,
            };
          }
          throw new Error(`Unexpected system prompt: ${opts.system}`);
        },
        dataforseoClient: {
          serp: {
            live: async () => [
              {
                type: "organic",
                title: "Bewakoof Oversized Tees",
                url: "https://bewakoof.com/oversized",
                description: "Shop cool streetwear tees online in India.",
              },
            ],
          },
        } as any,
        promptgenCandidates: async (promptgenContext: any) => {
          promptgenContext.onLlmSpend(0.04);
          return [{ text: "What are the best streetwear clothing brands in India?", topic: "Streetwear", source: "promptgen" }];
        },
      });

    await runQuestionSetup(memoContext(false), deps() as any);
    const callsAfterFirst = llmCalls;
    memo.delete("log");
    await runQuestionSetup(memoContext(true), deps() as any);

    assert.equal(llmCalls, callsAfterFirst, "a replay must not call the model again");
    assert.equal(logs[0].spendUsd, 0.15);
    assert.equal(logs[1].spendUsd, 0.15, "replayed LLM charges stay in the logged total");
  });

  it("bounds each setup LLM request and passes only the remaining approved aggregate", async () => {
    const approvedMaxUsd = 5;
    const ctx = createMockContext({ ...basePayload, approvedMaxUsd });
    const llmCalls: any[] = [];
    const searchQueries = ["oversized streetwear t-shirts india", "anime oversized tees brands"];
    const rivals = Array.from({ length: 10 }, (_, i) => `rival${i}.example`);

    const result = await runQuestionSetup(
      ctx,
      createMockDeps({
        env: { QUESTION_SETUP_PROMPTGEN: "off" },
        readPagesFree: async (urls: string[]) => ({
          pages: urls.map((url) => ({
            url,
            title: "Very long title ".repeat(300),
            content: "Very long page copy ".repeat(300),
          })),
          failed: [],
        }),
        dataforseoClient: {
          serp: {
            live: async () =>
              rivals.map((domain, i) => ({
                type: "organic",
                title: `Result ${i} ${"title ".repeat(300)}`,
                url: `https://${domain}/category`,
                description: "Competitor description ".repeat(300),
              })),
          },
        } as any,
        llmObject: async (opts: any) => {
          llmCalls.push(opts);
          if (opts.system.includes("Fill only the missing")) {
            return { object: { ...syntheticDraft, searchQueries }, usd: 0.01 };
          }
          if (opts.system.includes("Choose candidate competitors")) {
            return { object: { domains: rivals.slice(0, 5) }, usd: 0.02 };
          }
          if (opts.system.includes("Verify competitors")) {
            return {
              object: {
                competitors: [
                  {
                    name: "Rival 0",
                    domain: rivals[0],
                    notes: "Competing business",
                    sourceUrl: `https://${rivals[0]}/oversized`,
                  },
                ],
              },
              usd: 0.03,
            };
          }
          throw new Error(`Unexpected system prompt: ${opts.system}`);
        },
      }) as any,
    );

    assert.equal(llmCalls.length, 3);
    const bounds = [
      QUESTIONS_LLM_BOUNDS.setupDraft,
      QUESTIONS_LLM_BOUNDS.setupPick,
      QUESTIONS_LLM_BOUNDS.setupVerify,
    ];
    for (const [index, call] of llmCalls.entries()) {
      assert.ok(
        (call.system + call.prompt).length <= bounds[index].inputChars,
        `call ${index + 1} exceeded its quoted input bound`,
      );
      assert.equal(call.maxOutputTokens, bounds[index].outputTokens);
    }

    const serp1 = dataforseoPricing.serp.live({ depth: 10, keyword: searchQueries[0] });
    const serp2 = dataforseoPricing.serp.live({ depth: 10, keyword: searchQueries[1] });
    const expectedPickMax = fromMicros(
      toMicros(approvedMaxUsd) - toMicros(0.01) - toMicros(serp1) - toMicros(serp2),
    );
    const expectedVerifyMax = fromMicros(
      toMicros(expectedPickMax) - toMicros(0.02),
    );
    assert.deepEqual(
      llmCalls.map((call) => call.maxUsd),
      [approvedMaxUsd, expectedPickMax, expectedVerifyMax],
    );
  });

  it("logs the estimate for a PromptGen LLM failure that was settled as ambiguous", async () => {
    const ctx = createMockContext(basePayload);
    const model = "openai/gpt-4o-mini";
    const promptgenEnv = { LLM_HELPER_MODEL: model };
    let promptgenCall: any;
    let researchLog: any;

    const result = await runQuestionSetup(
      ctx,
      createMockDeps({
        env: { QUESTION_SETUP_PROMPTGEN: "on" },
        appendResearch: async (_admin: any, input: any) => {
          researchLog = input;
        },
        llmObject: async () => ({ object: syntheticDraft, usd: 0.01 }),
        dataforseoClient: { serp: { live: async () => [] } } as any,
        promptgenCandidates: async (promptgenContext: any, input: any) =>
          promptgenCandidates(promptgenContext, input, {
            env: promptgenEnv,
            fetchPeopleAlsoAsk: async () => [],
            fetchAutocomplete: async () => [],
            metered: async (_opts: any, call: any) => (await call()).value,
            llmText: async (opts: any) => {
              promptgenCall = opts;
              throw new AmbiguousCallError("The provider outcome is unknown.");
            },
          } as any),
      }) as any,
    );

    assert.ok(promptgenCall);
    assert.ok(result.result);
    assert.ok(
      (result.result as any).review.warnings.some((warning: any) => warning.code === "promptgen_unavailable"),
    );
    const promptgenEstimateUsd = estimateQuestionLlmUsd(
      model,
      (promptgenCall.system + promptgenCall.prompt).length,
      promptgenCall.maxOutputTokens,
      promptgenEnv,
    );
    assert.equal(toMicros(researchLog.spendUsd), toMicros(0.01) + toMicros(promptgenEstimateUsd));
  });

  it("skips all site and competitor reads when the workspace fields already exist", async () => {
    const ctx = createMockContext(basePayload);
    let siteReads = 0;
    let serpCalls = 0;
    let llmCalls = 0;
    const completeDraft = {
      topics: syntheticDraft.topics,
      suggestedKeywords: syntheticDraft.suggestedKeywords,
      persona: syntheticDraft.persona,
    };

    const res = await runQuestionSetup(
      ctx,
      createMockDeps({
        env: { QUESTION_SETUP_PROMPTGEN: "off" },
        sections: [{ key: "business_overview", content: "Saved business overview." }],
        competitors: [{ name: "Saved Rival", domain: "rival.example" }],
        discoverSiteUrls: async () => {
          siteReads += 1;
          return ["https://offcult.in/"];
        },
        readPagesFree: async () => {
          siteReads += 1;
          return { pages: [], failed: ["https://offcult.in/"] };
        },
        dataforseoClient: {
          serp: {
            live: async () => {
              serpCalls += 1;
              return [];
            },
          },
        } as any,
        llmObject: async () => {
          llmCalls += 1;
          return { object: completeDraft };
        },
      }) as any,
    );

    assert.equal(siteReads, 0);
    assert.equal(serpCalls, 0);
    assert.equal(llmCalls, 1);
    assert.equal((res.result as any).review.overview.preserved, true);
    assert.equal((res.result as any).review.competitors.preserved, true);
    assert.equal(ctx.stepsRun.some((entry) => entry.name.startsWith("competitor-free-")), false);
    assert.equal(ctx.stepsRun.some((entry) => entry.name === "verify"), false);
  });

  it("meters Firecrawl only for the failed page URLs", async () => {
    const ctx = createMockContext(basePayload);
    const firecrawlUrls: string[] = [];
    const meteredInputs: any[] = [];

    const res = await runQuestionSetup(
      ctx,
      createMockDeps({
        env: { QUESTION_SETUP_PROMPTGEN: "off", FIRECRAWL_SCRAPE_USD: "0.005" },
        discoverSiteUrls: async () => [
          "https://offcult.in/working.html",
          "https://offcult.in/blocked.html",
        ],
        readPagesFree: async () => ({
          pages: [],
          failed: ["https://offcult.in/blocked.html"],
        }),
        metered: async (input: any, call: any) => {
          meteredInputs.push(input);
          return (await call()).value;
        },
        readPageFirecrawl: async (url: string, meter: any) => {
          firecrawlUrls.push(url);
          const result = await meter({ estimateUsd: 0.005 }, async () => ({
            value: {
              content: "Readable website content from Firecrawl.",
              title: "Workspace",
              source: "firecrawl",
            },
            actualUsd: null,
            provider: "firecrawl",
            endpoint: "v1/scrape",
            billed: true,
          }));
          return {
            page: { url, title: "Workspace", content: result.content },
            billed: true,
          };
        },
        llmObject: async (opts: any) =>
          opts.system.includes("Fill only the missing")
            ? { object: syntheticDraft }
            : { object: { domains: [] } },
        dataforseoClient: { serp: { live: async () => [] } } as any,
      }) as any,
    );

    assert.equal(firecrawlUrls.length, 1);
    assert.deepStrictEqual(firecrawlUrls, ["https://offcult.in/blocked.html"]);
    assert.equal(meteredInputs[0].brandKey, basePayload.brandKey);
    assert.equal(meteredInputs[0].feature, "questions.setup");
    assert.equal(meteredInputs[0].jobId, ctx.jobId);
    assert.match(meteredInputs[0].idempotencyKey, new RegExp(`^job:${ctx.jobId}:site-firecrawl:1$`));
    assert.equal((res.result as any).review.overview.text, syntheticDraft.overview);
    const firecrawlStep = ctx.stepsRun.find((entry) => entry.name === "site-firecrawl");
    assert.equal(firecrawlStep?.opts.billed, true);
    assert.equal(firecrawlStep?.opts.retries, 0);
  });

  it("fails with website_unreadable when 0 pages read free and via firecrawl", async () => {
    const ctx = createMockContext(basePayload);

    const mockDeps = createMockDeps({
      discoverSiteUrls: async () => [],
      readPagesFree: async () => ({ pages: [], failed: [] }),
      readPageFirecrawl: async () => ({ page: null, billed: false }),
    });

    await assert.rejects(
      async () => {
        await runQuestionSetup(ctx, mockDeps as any);
      },
      (err: any) => {
        assert.ok(err instanceof AppError);
        assert.strictEqual(err.code, "website_unreadable");
        assert.strictEqual(err.status, 422);
        return true;
      },
    );
  });

  it("fails with budget_reached when approvedMaxUsd is too small for drafting", async () => {
    const ctx = createMockContext({
      ...basePayload,
      approvedMaxUsd: 0.0001, // extremely low budget
    });

    const mockDeps = createMockDeps({
      discoverSiteUrls: async () => ["https://offcult.in"],
      readPagesFree: async (urls: string[]) => ({
        pages: urls.map((u) => ({ url: u, title: "Title", content: "Some text" })),
        failed: [],
      }),
    });

    await assert.rejects(
      async () => {
        await runQuestionSetup(ctx, mockDeps as any);
      },
      (err: any) => {
        assert.ok(err instanceof AppError);
        assert.strictEqual(err.code, "budget_reached");
        assert.strictEqual(err.status, 402);
        return true;
      },
    );
  });

  it("drops unverifiable competitor and adds competitor_unverified warning", async () => {
    const ctx = createMockContext(basePayload);

    const mockDeps = createMockDeps({
      discoverSiteUrls: async () => ["https://offcult.in"],
      readPagesFree: async (urls: string[]) => ({
        pages: urls.map((u) => ({
          url: u,
          title: "Title",
          content: "Offcult streetwear catalog.",
        })),
        failed: [],
      }),
      llmObject: async (opts: any) => {
        if (opts.system.includes("Fill only the missing")) {
          return { object: syntheticDraft };
        }
        if (opts.system.includes("Choose candidate competitors")) {
          return { object: { domains: ["unverifiable-comp.com"] } };
        }
        if (opts.system.includes("Verify competitors")) {
          return {
            object: {
              competitors: [
                {
                  name: "FakeComp",
                  domain: "fakecomp.com",
                  notes: "Competitor note",
                  sourceUrl: "https://unknown-domain.com/page", // sourceUrl was never read!
                },
              ],
            },
          };
        }
        throw new Error(`Unexpected system prompt: ${opts.system}`);
      },
      dataforseoClient: {
        serp: {
          live: async () => [
            {
              type: "organic",
              title: "Some title",
              url: "https://unverifiable-comp.com",
              description: "Desc",
            },
          ],
        },
      } as any,
      promptgenCandidates: async () => [],
    });

    const res = await runQuestionSetup(ctx, mockDeps as any);
    const review = (res.result as any).review;
    assert.strictEqual(review.competitors.items.length, 0); // FakeComp was dropped!
    const warning = review.warnings.find((w: any) => w.code === "competitor_unverified");
    assert.ok(warning);
  });

  it("handles all-SERP outage by setting search_unavailable warning", async () => {
    const ctx = createMockContext(basePayload);

    const mockDeps = createMockDeps({
      discoverSiteUrls: async () => ["https://offcult.in"],
      readPagesFree: async (urls: string[]) => ({
        pages: urls.map((u) => ({
          url: u,
          title: "Title",
          content: "Offcult streetwear catalog.",
        })),
        failed: [],
      }),
      llmObject: async (opts: any) => {
        if (opts.system.includes("Fill only the missing")) {
          return { object: syntheticDraft };
        }
        throw new Error(`Unexpected system prompt: ${opts.system}`);
      },
      dataforseoClient: {
        serp: {
          live: async () => {
            throw new Error("DataForSEO upstream 503 outage");
          },
        },
      } as any,
      promptgenCandidates: async () => [],
    });

    const res = await runQuestionSetup(ctx, mockDeps as any);
    const review = (res.result as any).review;
    const searchWarning = review.warnings.find((w: any) => w.code === "search_unavailable");
    assert.ok(searchWarning);
    assert.strictEqual(review.competitors.items.length, 0);
  });
});
