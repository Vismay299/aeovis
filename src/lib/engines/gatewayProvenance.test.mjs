import test from "node:test";
import assert from "node:assert/strict";

import {
  probeTextEngine,
  probeAioDataforseo,
} from "../scoring/enginePipeline.js";
import { probeOpenRouterEngine } from "./openRouterProbe.js";
import { probeChatGpt } from "./openai.js";
import { probePerplexity } from "./perplexity.js";
import {
  probeDataforseoScraper,
  probeDataforseoModel,
} from "./dataforseo.ts";

test("F02-AC-19: OpenRouter probe carries provenance.gateway 'openrouter'", async () => {
  const result = await probeTextEngine(
    {
      name: "gemini",
      probe: async () => ({
        text: "Sample gemini answer.",
        citations: [],
        references: [],
        model: "google/gemini-2.5-flash",
        gateway: "openrouter",
        cost: 0.001,
        cost_source: "gateway",
        cost_state: "measured",
      }),
    },
    { text: "test query" },
    "Offcult",
    ["offcult"],
    "offcult.in",
    [],
    {},
  );

  assert.equal(result.provenance?.gateway, "openrouter");
  assert.equal(result.gateway, "openrouter");
});

test("F02-AC-19: OpenAI native probe carries provenance.gateway 'openai'", async () => {
  const result = await probeTextEngine(
    {
      name: "chatgpt",
      probe: async () => ({
        text: "Sample chatgpt answer.",
        citations: [],
        references: [],
        model: "gpt-4o-mini",
        gateway: "openai",
        cost: 0.002,
        cost_source: "openai",
        cost_state: "measured",
      }),
    },
    { text: "test query" },
    "Offcult",
    ["offcult"],
    "offcult.in",
    [],
    {},
  );

  assert.equal(result.provenance?.gateway, "openai");
  assert.equal(result.gateway, "openai");
});

test("F02-AC-19: Perplexity native probe carries provenance.gateway 'perplexity'", async () => {
  const result = await probeTextEngine(
    {
      name: "perplexity",
      probe: async () => ({
        text: "Sample perplexity answer.",
        citations: [],
        references: [],
        model: "sonar",
        gateway: "perplexity",
        cost: 0.005,
        cost_source: "perplexity",
        cost_state: "measured",
      }),
    },
    { text: "test query" },
    "Offcult",
    ["offcult"],
    "offcult.in",
    [],
    {},
  );

  assert.equal(result.provenance?.gateway, "perplexity");
  assert.equal(result.gateway, "perplexity");
});

test("F02-AC-19: DataForSEO scraper and model probes carry provenance.gateway 'dataforseo'", async () => {
  const FAKE_ENV = { DATAFORSEO_API_KEY: "fake_dfs_key" };

  const scraperResult = await probeTextEngine(
    {
      name: "chatgpt",
      probe: async (prompt, opts) =>
        probeDataforseoScraper("chatgpt", prompt, {
          measurementContext: { country: "in", language: "en" },
          env: FAKE_ENV,
          fetchImpl: async () =>
            new Response(
              JSON.stringify({
                status_code: 20000,
                tasks: [
                  {
                    id: "task-dfs-scrape-001",
                    status_code: 20000,
                    cost: 0.004,
                    result: [
                      {
                        datetime: "2026-10-20 10:00:00 +00:00",
                        markdown: "ChatGPT response via DataForSEO.",
                        sources: [],
                      },
                    ],
                  },
                ],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
        }),
    },
    { text: "test query" },
    "Offcult",
    ["offcult"],
    "offcult.in",
    [],
    {},
    { route: "dataforseo" },
  );

  assert.equal(scraperResult.provenance?.gateway, "dataforseo");
  assert.equal(scraperResult.gateway, "dataforseo");
  assert.equal(scraperResult.measurement_method, "consumer_capture");

  const modelResult = await probeTextEngine(
    {
      name: "perplexity",
      probe: async (prompt, opts) =>
        probeDataforseoModel("perplexity", prompt, {
          measurementContext: { country: "in", language: "en" },
          model: "sonar",
          env: FAKE_ENV,
          fetchImpl: async () =>
            new Response(
              JSON.stringify({
                status_code: 20000,
                tasks: [
                  {
                    id: "task-dfs-model-001",
                    status_code: 20000,
                    cost: 0.04,
                    result: [
                      {
                        model_name: "sonar",
                        output_tokens: 256,
                        web_search: true,
                        items: [
                          {
                            type: "message",
                            sections: [
                              {
                                type: "text",
                                text: "Perplexity response via DataForSEO.",
                                annotations: [],
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
        }),
    },
    { text: "test query" },
    "Offcult",
    ["offcult"],
    "offcult.in",
    [],
    {},
    { route: "dataforseo" },
  );

  assert.equal(modelResult.provenance?.gateway, "dataforseo");
  assert.equal(modelResult.gateway, "dataforseo");
  assert.equal(modelResult.measurement_method, "model_api");
});

test("F02-AC-19: probeAioDataforseo carries provenance.gateway 'dataforseo'", async () => {
  const aioResult = await probeAioDataforseo(
    { text: "test aio query" },
    "Offcult",
    ["offcult"],
    "offcult.in",
    [],
    {},
    {
      measurementContext: { country: "in", language: "en" },
      env: { DATAFORSEO_API_KEY: "fake_dfs_key" },
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            status_code: 20000,
            tasks: [
              {
                id: "task-dfs-aio-001",
                status_code: 20000,
                cost: 0.002,
                result: [
                  {
                    items: [
                      {
                        type: "ai_overview",
                        markdown: "AI Overview via DataForSEO.",
                        references: [],
                      },
                      {
                        type: "organic",
                        rank_group: 1,
                        domain: "offcult.in",
                        url: "https://offcult.in",
                      },
                    ],
                  },
                ],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    },
  );

  assert.equal(aioResult.provenance?.gateway, "dataforseo");
  assert.equal(aioResult.gateway, "dataforseo");
  assert.equal(aioResult.measurement_method, "google_serp");
});
