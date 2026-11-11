import test from "node:test";
import assert from "node:assert/strict";

import {
  probeDataforseoScraper,
  probeDataforseoModel,
  fetchDataforseoAioSerp,
  dataforseoTextResult,
  postDataforseoBatch,
  collectDataforseoTask,
  type DfsProbeOptions,
} from "./dataforseo.ts";
import { evidenceDocument } from "../db/measurementEvidence.js";
import { evidenceRedactionStatus } from "../evidenceRedaction.js";

const FAKE_ENV = {
  DATAFORSEO_API_KEY: "fake_dfs_key",
};

test("F02-AC-18 & F02-AC-25: probeDataforseoScraper returns consumer_capture shape and captures evidence without headers", async () => {
  const taskId = "10201100-2356-0275-0000-scraper001";
  const fakeResponse = {
    status_code: 20000,
    tasks: [
      {
        id: taskId,
        status_code: 20000,
        cost: 0.004,
        result: [
          {
            datetime: "2026-10-20 10:00:00 +00:00",
            markdown: "ChatGPT response mentioning Offcult. Check [Offcult](https://offcult.in).",
            sources: [
              { url: "https://offcult.in/shop", title: "Offcult Store" },
            ],
          },
        ],
      },
    ],
  };

  let capturedEvidence: any = null;
  const mockFetch = async () =>
    new Response(JSON.stringify(fakeResponse), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const options: DfsProbeOptions = {
    measurementContext: { country: "in", language: "en" },
    env: FAKE_ENV,
    fetchImpl: mockFetch as unknown as typeof fetch,
    captureEvidence: async (ev) => {
      capturedEvidence = ev;
    },
  };

  const result = await probeDataforseoScraper("chatgpt", "trendy oversized t-shirts", options);

  // F02-AC-18: result shape assertions
  assert.equal(result.gateway, "dataforseo");
  assert.equal(result.measurement_method, "consumer_capture");
  assert.equal(result.cost, 0.004);
  assert.equal(result.cost_source, "gateway");
  assert.equal(result.cost_state, "measured");
  assert.equal(result.requested_model, "dataforseo:llm_scraper:chatgpt");
  assert.equal(result.returned_model, null);
  assert.equal(result.provider_request_id, taskId);
  assert.equal(result.provider_task_id, taskId);
  assert.equal(result.search_requests, null);
  assert.equal(result.error, null);
  assert.match(result.text, /ChatGPT response mentioning Offcult/);
  assert.equal(result.references.length, 1);
  assert.equal(result.references[0].href, "https://offcult.in/shop");
  assert.equal(result.citations_state, "verified");

  // F02-AC-25: evidence capture assertions
  assert.ok(capturedEvidence, "Evidence must be captured");
  assert.equal(capturedEvidence.provider, "dataforseo");
  assert.equal(capturedEvidence.surface, "chatgpt");
  assert.equal(capturedEvidence.requestId, taskId);
  assert.equal("headers" in capturedEvidence.payload, false, "Evidence payload must not contain headers");
  assert.equal("headers" in capturedEvidence, false);

  const doc = evidenceDocument(capturedEvidence);
  assert.ok(doc, "evidenceDocument should succeed");
  const redaction = evidenceRedactionStatus(doc.document);
  assert.equal(redaction.safe, true, "evidence capture must pass evidenceRedactionStatus");
});

test("F02-AC-18 & F02-AC-25: probeDataforseoModel returns model_api shape and captures evidence without headers", async () => {
  const taskId = "10201100-2356-0275-0000-model001";
  const fakeResponse = {
    status_code: 20000,
    tasks: [
      {
        id: taskId,
        status_code: 20000,
        cost: 0.04,
        result: [
          {
            model_name: "sonar-reasoning-pro",
            output_tokens: 512,
            web_search: true,
            fan_out_queries: ["offcult clothing", "streetwear india"],
            items: [
              {
                type: "message",
                sections: [
                  {
                    type: "text",
                    text: "Perplexity answer recommending Indian streetwear brands.",
                    annotations: [
                      {
                        type: "url_citation",
                        title: "Top Indian Brands",
                        url: "https://example.com/brands",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  let capturedEvidence: any = null;
  const mockFetch = async () =>
    new Response(JSON.stringify(fakeResponse), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const options: DfsProbeOptions = {
    measurementContext: { country: "in", language: "en" },
    env: FAKE_ENV,
    model: "sonar-reasoning-pro",
    webSearch: true,
    fetchImpl: mockFetch as unknown as typeof fetch,
    captureEvidence: async (ev) => {
      capturedEvidence = ev;
    },
  };

  const result = await probeDataforseoModel("perplexity", "best streetwear brands india", options);

  // F02-AC-18: result shape assertions
  assert.equal(result.gateway, "dataforseo");
  assert.equal(result.measurement_method, "model_api");
  assert.equal(result.cost, 0.04);
  assert.equal(result.cost_source, "gateway");
  assert.equal(result.cost_state, "measured");
  assert.equal(result.requested_model, "sonar-reasoning-pro");
  assert.equal(result.returned_model, "sonar-reasoning-pro");
  assert.equal(result.provider_request_id, taskId);
  assert.equal(result.provider_task_id, taskId);
  assert.equal(result.search_requests, 1);
  assert.equal(result.output_tokens, 512);
  assert.deepEqual(result.fan_out_queries, ["offcult clothing", "streetwear india"]);
  assert.equal(result.citations_state, "verified");

  // F02-AC-25: evidence capture assertions
  assert.ok(capturedEvidence, "Evidence must be captured");
  assert.equal(capturedEvidence.provider, "dataforseo");
  assert.equal(capturedEvidence.surface, "perplexity");
  assert.equal(capturedEvidence.requestId, taskId);
  assert.equal("headers" in capturedEvidence.payload, false, "Evidence payload must not contain headers");

  const doc = evidenceDocument(capturedEvidence);
  assert.ok(doc, "evidenceDocument should succeed");
  const redaction = evidenceRedactionStatus(doc.document);
  assert.equal(redaction.safe, true, "evidence capture must pass evidenceRedactionStatus");
});

test("F02 phase 4: queued posts map accepted and rejected tags with per-entry costs", async () => {
  const capturedRequest: { value: RequestInit | null } = { value: null };
  let url = "";
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    url = String(input);
    capturedRequest.value = init ?? null;
    return new Response(JSON.stringify({
      status_code: 20000,
      tasks: [
        { id: "task-1", status_code: 20100, cost: 0.0012, data: { tag: "obs-1" } },
        { status_code: 40501, status_message: "No Search Results.", cost: 0.0004, data: { tag: "obs-2" } },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await postDataforseoBatch(
    "chatgpt",
    [{ observationId: "obs-1", query: "Question one?" }, { observationId: "obs-2", query: "Question two?" }],
    { locationCode: 2356, languageCode: "en", isoCountry: "IN" },
    { env: FAKE_ENV, fetchImpl: fetchImpl as unknown as typeof fetch },
  );
  assert.equal(url, "https://api.dataforseo.com/v3/ai_optimization/chat_gpt/llm_scraper/task_post");
  assert.equal(capturedRequest.value?.method, "POST");
  const body = JSON.parse(String(capturedRequest.value?.body));
  assert.equal(body.length, 2);
  assert.equal(body[0].tag, "obs-1");
  assert.deepEqual(result.posted, [{ observationId: "obs-1", taskId: "task-1", costUsd: 0.0012 }]);
  assert.deepEqual(result.rejected, [{
    observationId: "obs-2",
    statusCode: 40501,
    message: "No Search Results.",
    costUsd: 0.0004,
  }]);
});

test("F02 phase 4: queued task_get distinguishes pending and completed free reads", async () => {
  const responses = [
    { status_code: 20000, tasks: [{ id: "task-1", status_code: 40601, cost: 0 }] },
    { status_code: 20000, tasks: [{ id: "task-1", status_code: 20000, cost: 0, result: [{ markdown: "An answer" }] }] },
  ];
  const fetchImpl = async () => new Response(JSON.stringify(responses.shift()), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const pending = await collectDataforseoTask("chatgpt", "task-1", {
    env: FAKE_ENV,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  assert.deepEqual(pending, { status: "pending" });
  const completed = await collectDataforseoTask("chatgpt", "task-1", {
    env: FAKE_ENV,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  assert.equal(completed.status, "completed");
  if (completed.status === "completed") {
    assert.equal((completed.result as any).result[0].markdown, "An answer");
    assert.equal(completed.costUsd, 0);
  }
});

test("F02-AC-18 & F02-AC-25: fetchDataforseoAioSerp returns valid SERP and captures evidence", async () => {
  const taskId = "10201100-2356-0275-0000-serpaio001";
  const fakeResponse = {
    status_code: 20000,
    tasks: [
      {
        id: taskId,
        status_code: 20000,
        cost: 0.002,
        result: [
          {
            items: [
              {
                type: "ai_overview",
                markdown: "Google AI Overview for streetwear.",
                references: [{ url: "https://offcult.in", title: "Offcult" }],
              },
              {
                type: "organic",
                rank_group: 1,
                domain: "offcult.in",
                url: "https://offcult.in",
              },
              {
                type: "organic",
                rank_group: 2,
                domain: "bewakoof.com",
                url: "https://bewakoof.com",
              },
            ],
          },
        ],
      },
    ],
  };

  let capturedEvidence: any = null;
  const mockFetch = async () =>
    new Response(JSON.stringify(fakeResponse), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const options: DfsProbeOptions = {
    measurementContext: { country: "in", language: "en" },
    env: FAKE_ENV,
    fetchImpl: mockFetch as unknown as typeof fetch,
    captureEvidence: async (ev) => {
      capturedEvidence = ev;
    },
  };

  const aioData = await fetchDataforseoAioSerp("streetwear in india", options);

  assert.equal(aioData.gateway, "dataforseo");
  assert.equal(aioData.serp_state, "valid_serp");
  assert.equal(aioData.aio_present, true);
  assert.equal(aioData.cost, 0.002);
  assert.equal(aioData.provider_request_id, taskId);
  assert.equal(aioData.organic.length, 2);
  assert.equal(aioData.organic[0].domain, "offcult.in");

  assert.ok(capturedEvidence);
  assert.equal(capturedEvidence.provider, "dataforseo");
  assert.equal(capturedEvidence.surface, "aio");
  assert.equal("headers" in capturedEvidence.payload, false);

  const doc = evidenceDocument(capturedEvidence);
  assert.equal(evidenceRedactionStatus(doc.document).safe, true);
});

test("successful DataForSEO adapters preserve an omitted task cost as unknown billed", async () => {
  const payloads = [
    {
      status_code: 20000,
      tasks: [{
        id: "scraper-no-cost",
        status_code: 20000,
        result: [{ markdown: "A scraper answer without reported billing." }],
      }],
    },
    {
      status_code: 20000,
      tasks: [{
        id: "model-no-cost",
        status_code: 20000,
        result: [{
          model_name: "sonar-reasoning-pro",
          output_tokens: 8,
          web_search: true,
          fan_out_queries: [],
          items: [{ type: "message", sections: [{ type: "text", text: "A model answer without reported billing." }] }],
        }],
      }],
    },
    {
      status_code: 20000,
      tasks: [{
        id: "aio-no-cost",
        status_code: 20000,
        result: [{ items: [{ type: "organic", rank_group: 1, domain: "example.com", url: "https://example.com" }] }],
      }],
    },
  ];
  let index = 0;
  const fetchImpl = async () => new Response(JSON.stringify(payloads[index++]), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const stats: Record<string, number> = {};
  const options: DfsProbeOptions = {
    measurementContext: { country: "in", language: "en" },
    env: FAKE_ENV,
    model: "sonar-reasoning-pro",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    stats,
  };

  const scraper = await probeDataforseoScraper("chatgpt", "query", options);
  const model = await probeDataforseoModel("perplexity", "query", options);
  const aio = await fetchDataforseoAioSerp("query", options);

  for (const result of [scraper, model]) {
    assert.equal(result.cost, null);
    assert.equal(result.cost_source, null);
    assert.equal(result.cost_state, "unknown_billed");
  }
  assert.equal(aio.cost, null);
  assert.equal(aio.task.cost, null);
  assert.equal(stats.cost_unmeasured_calls, 3);
});

test("F02-AC-18: dataforseoTextResult handles empty citations and web search unverified reason", () => {
  const result = dataforseoTextResult(
    "perplexity",
    {
      answerMarkdown: "Direct answer with no citations.",
      answerText: "Direct answer with no citations.",
      citations: [],
      collectedAt: null,
      fanOutQueries: [],
      outputTokens: 100,
      webSearch: false,
      modelName: "sonar",
    },
    { id: "task-001", cost: 0.01 },
    {
      method: "model_api",
      requestedModel: "sonar",
      returnedModel: "sonar",
      webSearch: false,
      fanOut: [],
      outputTokens: 100,
    },
  );

  assert.equal(result.citations_state, "unverified");
  assert.equal(result.citations_state_reason, "web_search_not_used");
});

test("Phase 4 adapters refuse invalid batches and task identifiers before network access", async () => {
  await assert.rejects(
    async () => postDataforseoBatch("chatgpt", [], { locationCode: 2356, languageCode: "en", isoCountry: "IN" }),
    (error: any) => error.code === "dataforseo_task_count_invalid",
  );
  await assert.rejects(
    async () => collectDataforseoTask("chatgpt", ""),
    (error: any) => error.code === "dataforseo_task_id_invalid",
  );
});
