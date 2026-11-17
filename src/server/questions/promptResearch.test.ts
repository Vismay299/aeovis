import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  words,
  mergeKey,
  mergeNearDuplicates,
  researchQuestions,
  listResearchKeywords,
} from "./promptResearch.ts";
import type { Workspace } from "../workspace/requireWorkspace.ts";

describe("promptResearch helpers (F08-AC-18, F08-AC-19)", () => {
  it("extracts words, stems 's' unless 'ss', and lowercases", () => {
    const list = words("Top Streetwear Tees and Hoodies in 2025 across classes");
    assert.deepStrictEqual(list, [
      "top",
      "streetwear",
      "tee",
      "and",
      "hoodie",
      "in",
      "2025",
      "across",
      "classe",
    ]);
  });

  it("computes mergeKey dropping years and common articles", () => {
    const k1 = mergeKey("What is the best oversized t-shirt in 2024?");
    const k2 = mergeKey("What is a best oversized t-shirt in 2025?");
    assert.strictEqual(k1, k2);
  });

  it("merges near duplicates grouping by mergeKey with highest volume first", () => {
    const prompts = [
      { question: "best streetwear tees in 2024", volume: 100 },
      { question: "best streetwear tees in 2025", volume: 300 },
      { question: "completely different question", volume: 50 },
    ];
    const groups = mergeNearDuplicates(prompts);
    assert.strictEqual(groups.length, 2);
    assert.strictEqual(groups[0][0].question, "best streetwear tees in 2025");
    assert.strictEqual(groups[0][1].question, "best streetwear tees in 2024");
  });
});

describe("researchQuestions end-to-end", () => {
  const mockAdmin: any = {
    from() {
      return {
        select() {
          const chain: any = {
            eq() {
              return chain;
            },
            order() {
              return chain;
            },
            data: [],
            error: null,
            then(resolve: any) {
              return Promise.resolve({ data: [], error: null }).then(resolve);
            },
          };
          return chain;
        },
      };
    },
  };
  const dummyWorkspace: Workspace = {
    brandKey: "offcult.in",
    user: { id: "00000000-0000-0000-0000-000000000001", email: "user@example.com" },
    role: "owner",
    admin: mockAdmin,
    brand: {
      display_name: "Offcult",
      website: "https://offcult.in",
      website_host: "offcult.in",
      aliases: ["Offcult"],
      brandKey: "offcult.in",
      role: "owner",
      is_active: true,
    },
  };

  it("queries mentionsSearch, applies relevance filtering, and returns researched questions", async () => {
    const fixtureDir = path.resolve(process.cwd(), "tests/fixtures/f08");
    const datasetFixture = JSON.parse(
      await fs.readFile(path.join(fixtureDir, "llm-mentions-search.json"), "utf8"),
    );
    const relevanceFixture = JSON.parse(
      await fs.readFile(path.join(fixtureDir, "llm-relevance.json"), "utf8"),
    );
    let datasetCalls = 0;
    let relevanceCalls = 0;
    const appended: any[] = [];
    const cache = new Map<string, unknown>();
    const mockDeps = {
      cached: async (opts: any, fetcher: any) => {
        const key = JSON.stringify([
          opts.namespace,
          opts.keyParts,
          opts.scope === "workspace" ? opts.brandKey : "",
        ]);
        if (cache.has(key)) {
          return { hit: true, value: cache.get(key), fetchedAt: "2026-11-10T00:00:00.000Z" };
        }
        const value = await fetcher();
        cache.set(key, value);
        return { hit: false, value, fetchedAt: "2026-11-10T00:00:00.000Z" };
      },
      dataforseoClient: {
        aiSearch: {
          mentionsSearch: async () => {
            datasetCalls += 1;
            return datasetFixture;
          },
        },
      } as any,
      llmObject: async () => {
        relevanceCalls += 1;
        return { object: relevanceFixture, usd: null, model: "fixture" };
      },
      repo: {
        listSections: async () => [
          { key: "business_overview", content: "Offcult sells streetwear and oversized tees." },
        ],
      } as any,
      listWorkspaceQuestions: async () => [
        {
          text: "How to style oversized t-shirts?",
          textNormalized: "how to style oversized t-shirts?",
          status: "active",
        },
      ] as any,
      findRecentResearch: async () => ({
        entryDate: "2026-10-09",
        summary: "Earlier research exists.",
      }),
      appendResearch: async (_admin: any, input: any) => {
        appended.push(input);
      },
    };

    const res = await researchQuestions(
      mockAdmin,
      dummyWorkspace,
      {
        requestId: "00000000-0000-0000-0000-000000000001",
        keyword: "streetwear tees",
      },
      mockDeps as any,
    );

    assert.strictEqual(res.keyword, "streetwear tees");
    assert.strictEqual(res.dataset, "us-en");
    assert.strictEqual(res.questions.length, 2);

    const q = res.questions[0];
    assert.ok(q.text.includes("What are the best oversized t-shirts"));
    assert.equal(q.variants.length, 1);
    assert.ok(q.variants[0].includes("2025"));
    assert.strictEqual(q.ownDomainCited, true);
    assert.strictEqual(q.brandMentioned, true);
    assert.strictEqual(q.tracked, false);
    assert.strictEqual(q.sources.length, 3);
    assert.strictEqual(q.sources[0].own, true);
    assert.strictEqual(q.sources[1].own, false);
    assert.strictEqual(q.sources[2].own, false);
    assert.equal(res.questions[1].tracked, true);
    assert.deepStrictEqual(res.recent, {
      entryDate: "2026-10-09",
      summary: "Earlier research exists.",
    });

    assert.ok(appended[0].summary.includes('Question research for "streetwear tees"'));

    const second = await researchQuestions(
      mockAdmin,
      dummyWorkspace,
      {
        requestId: "00000000-0000-0000-0000-000000000002",
        keyword: "streetwear tees",
      },
      mockDeps as any,
    );
    assert.equal(second.questions.length, 2);
    assert.equal(datasetCalls, 1, "the second search reuses the global dataset cache");
    assert.equal(relevanceCalls, 1, "the second search reuses the workspace relevance cache");
    assert.equal(appended.length, 1, "a cache hit does not append another research log row");
  });

  it("logs an empty dataset miss without paying for relevance", async () => {
    let llmCalls = 0;
    let logged: any;
    const result = await researchQuestions(
      mockAdmin,
      dummyWorkspace,
      {
        requestId: "00000000-0000-0000-0000-000000000003",
        keyword: "no results keyword",
      },
      {
        cached: async (_opts: any, fetcher: any) => ({
          hit: false,
          value: await fetcher(),
          fetchedAt: "2026-11-10T00:00:00.000Z",
        }),
        dataforseoClient: {
          aiSearch: { mentionsSearch: async () => [] },
        } as any,
        llmObject: async <T>() => {
          llmCalls += 1;
          return { object: { relevantIds: [] } as T, usd: null, model: "fixture" };
        },
        repo: { listSections: async () => [] } as any,
        findRecentResearch: async () => null,
        appendResearch: async (_admin: any, input: any) => {
          logged = input;
        },
      },
    );

    assert.deepStrictEqual(result.questions, []);
    assert.equal(llmCalls, 0);
    assert.equal(logged.summary, 'Question research for "no results keyword": 0 relevant questions.');
  });

  it("lists research keywords combining settings and workspace topics", async () => {
    const mockDeps = {
      readQuestionSettings: async () => ({
        researchKeywords: ["anime tees", "streetwear"],
      } as any),
      listWorkspaceQuestions: async () => [
        { topic: "General" },
        { topic: "Streetwear" }, // duplicate of settings keyword
        { topic: "Hoodies" },
      ] as any,
    };

    const res = await listResearchKeywords(mockAdmin, "offcult.in", mockDeps as any);
    assert.deepStrictEqual(res.keywords, ["anime tees", "streetwear", "Hoodies"]);
  });
});
