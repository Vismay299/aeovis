#!/usr/bin/env node
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { chromium } from "../../worker/node_modules/playwright/index.mjs";
const origin = process.argv[2] || "http://127.0.0.1:3340";
if (!["127.0.0.1", "localhost"].includes(new URL(origin).hostname))
  throw Error("Browser acceptance requires isolated local app");
for (const key of [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "PERPLEXITY_API_KEY",
  "BRIGHTDATA_API_KEY",
])
  delete process.env[key];
const { runFinalizePhase } = await import(
  "../../src/lib/workers/scanWorker.js"
);
const { makeMemoryScanBackend } = await import(
  "../../src/lib/demo/memoryScanBackend.js"
);
async function fixture(valid,planned=30,mentions=valid) {
  const backend = makeMemoryScanBackend(),
    queries = Array.from({ length: planned }, (_, i) => `Buyer question ${i}`),
    jobId = `fixture-${valid}-${planned}-${mentions}`;
  await backend.deps.upsertPromptResults(
    queries.map((query, i) => ({
      id: `result-${i}`,
      job_id: jobId,
      engine: "chatgpt",
      query,
      answered: i < valid,
      raw: {
        engine: "chatgpt",
        prompt: query,
        answer_present: i < valid,
        text: i < valid ? i < mentions ? "Acme is an option." : "A general answer with no vendor named." : "",
        error: i < valid ? null : "Fixture provider timeout",
        visible: i < valid && i < mentions,
        brand_mentioned_in_text: i < valid && i < mentions,
        brand_cited: false,
        references: [],
        brands: [],
        cost: null,
      },
    })),
  );
  const job = await runFinalizePhase(
    jobId,
    {
      brand: "Acme",
      url: "https://acme.example",
      prompt_key: "acme.example",
      competitors: [],
      engines: ["chatgpt"],
      queries: queries.map((text) => ({ text })),
      unbranded_texts: queries.map((q) => q.toLowerCase()),
      geo: "in",
      stats: {},
      model_policy_version: "fixture-only",
    },
    {
      ...backend.deps,
      resolveEnabledEngines: () => [{ name: "chatgpt" }],
      extractCompetitors: async () => [],
    },
  );
  return {
    id: jobId,
    brand: "Acme",
    url: "https://acme.example",
    raw_results: job.run_record,
    visibility_pct: job.run_record.visibility_pct,
  };
}
const fixtures = {
  partial: await fixture(29),
  failed: await fixture(0),
  complete: await fixture(30),
  thin:await fixture(5,5),
  zero:await fixture(30,30,0),
};
const browser = await chromium.launch({ headless: true });
const passed = [];
try {
  for (const [name, status] of [
    ["authentication", 401],
    ["missing", 404],
    ["denied", 403],
    ["backend", 503],
    ["malformed", 200],
  ]) {
    const page = await browser.newPage();
    let paid = 0,
      reads = 0;
    await page.route("**/api/**", async (route) => {
      if (route.request().method() === "POST") {
        paid++;
        return route.abort();
      }
      reads++;
      return route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify({ error: "Fixture response" }),
      });
    });
    await page.goto(`${origin}/dashboard/acme/report-fixture`);
    await page.locator("section[role=alert]").first().waitFor();
    const body = await page.locator("main").innerText();
    assert.equal(body.includes("No scans yet"), false);
    assert.equal(body.includes("0%"), false);
    if (status >= 500 || status === 200) {
      const before = reads;
      await page
        .getByRole("button", { name: "Retry report", exact: true })
        .click();
      await page.locator("section[role=alert]").first().waitFor();
      assert.ok(reads > before);
      assert.equal(
        new URL(page.url()).pathname,
        "/dashboard/acme/report-fixture",
      );
    }
    if (status === 401)
      await page.getByRole("link", { name: "Sign in", exact: true }).waitFor();
    assert.equal(paid, 0);
    passed.push(`R13-B ${name}: opaque/error recovery and zero paid requests`);
    await page.close();
  }
  for (const name of ["complete", "partial", "failed"]) {
    const page = await browser.newPage({ acceptDownloads: true });
    let paid = 0;
    await page.route("**/api/**", (route) => {
      if (route.request().method() === "POST") {
        paid++;
        return route.abort();
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          route.request().url().includes("/by-id/")
            ? { scan: fixtures[name] }
            : { scans: [], items: [] },
        ),
      });
    });
    await page.goto(`${origin}/dashboard/acme/report-fixture`);
    const banner = page.getByRole("status", { name: "Collection outcome" });
    await banner.waitFor();
    assert.match(await banner.innerText(), new RegExp(`Collection: ${name}`));
    const downloadPromise = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download measurement JSON" })
      .click();
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    let json = "";
    for await (const chunk of stream) json += chunk;
    assert.deepEqual(
      JSON.parse(json).raw_results.summary_stats.terminal_outcome,
      fixtures[name].raw_results.summary_stats.terminal_outcome,
    );
    await page.reload();
    await banner.waitFor();
    assert.equal(paid, 0);
    passed.push(
      `R03/R05-B ${name}: durable reload and downloaded outcome/count agreement`,
    );
    await page.close();
  }
  for(const name of ["thin","zero","failed"]){
    const page=await browser.newPage({acceptDownloads:true});let paid=0;
    await page.route("**/api/**",route=>{if(route.request().method()==="POST"){paid++;return route.abort();}return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().url().includes("/by-id/")?{scan:fixtures[name]}:{scans:[],items:[]})});});
    await page.goto(`${origin}/dashboard/acme/report-fixture`);
    await page.getByRole("status",{name:"Collection outcome"}).waitFor();
    const metric=fixtures[name].raw_results.summary_stats.headline_metric;
    if(name==="thin"){
      const qualifier=page.getByTestId("headline-qualification");await qualifier.waitFor();
      assert.match(await qualifier.innerText(),/Insufficient evidence for a headline/);
      assert.match(await qualifier.innerText(),/5 of 5 eligible observations/);
      assert.equal(metric.value_pct,100);assert.equal(metric.qualified_pct,null);
      if(await page.getByTestId("score-band").count())assert.ok((await page.getByTestId("score-band").locator(".num").innerText()).includes("—"));
    }else if(name==="zero"){
      assert.equal(metric.value_pct,0);assert.equal(metric.qualified_pct,0);
      await page.getByTestId("score-band").waitFor();assert.match(await page.getByTestId("score-band").locator(".num").innerText(),/^0/);
    }else{
      assert.equal(metric.qualified_pct,null);assert.equal(await page.getByTestId("score-band").count(),0);
      await page.getByTestId("dashboard-unreliable-placeholder").waitFor();
    }
    const pending=page.waitForEvent("download");await page.getByRole("button",{name:"Download measurement JSON"}).click();
    const stream=await (await pending).createReadStream();let data="";for await(const chunk of stream)data+=chunk;
    assert.deepEqual(JSON.parse(data).raw_results.summary_stats.headline_metric,metric);assert.equal(paid,0);
    passed.push(`R05-22/23-B ${name}: qualified versus exploratory/unknown screen state agrees with exact downloaded metric DTO`);await page.close();
  }
  for (const [name, title, tone] of [["complete", "Scan complete", "success"], ["partial", "Partial collection", "warning"], ["failed", "Collection failed", "error"]]) {
    const page = await browser.newPage();
    let simulatedStarts = 0;
    await page.route("**/api/**", route => {
      const pathname = new URL(route.request().url()).pathname;
      let body = { scans: [], items: [] };
      if (route.request().method() === "POST") {
        assert.equal(pathname, "/api/scan");
        simulatedStarts++;
        body = { job_id: `fixture-${name}` };
      } else if (pathname.endsWith("/status")) {
        body = { status: "complete", result_id: fixtures[name].id, terminal_outcome: fixtures[name].raw_results.summary_stats.terminal_outcome };
      } else if (pathname.includes("/by-id/")) body = { scan: fixtures[name] };
      else if (pathname === "/api/industries") body = [];
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto(`${origin}/scan`);
    await page.getByTestId("scan-brand-input").fill("Acme");
    await page.getByTestId("scan-website-input").fill("acme.example");
    await page.getByTestId("scan-submit-btn").click();
    const toast = page.locator("[data-sonner-toast]").filter({ hasText: title }).first();
    await toast.waitFor();
    assert.equal(await toast.getAttribute("data-type"), tone);
    assert.equal(simulatedStarts, 1);
    passed.push(`R03-14-B ${name}: completed execution shows ${tone} collection notice and no automatic rescan`);
    await page.close();
  }
  const ops = await browser.newPage();
  await ops.route("**/api/measurement/operations", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        readiness: {
          engines: {
            aio: {
              readiness: "stale",
              operator_action: "Run a bounded canary",
            },
          },
        },
        incidents: [
          {
            id: "fixture-incident",
            engine: "aio",
            kind: "parser_drift",
            parser_version: "fixture-v1",
            first_seen: "2026-10-20",
            last_seen: "2026-10-20",
            occurrences: 1,
          },
        ],
        observations: [
          {
            id: "fixture-observation",
            engine: "chatgpt",
            state: "ambiguous",
            attempt_count: 2,
            unknown_cost_calls: 1,
            total_cost: 0.01,
          },
        ],
        windows: [],
      }),
    }),
  );
  await ops.goto(`${origin}/ops/measurement`);
  await ops
    .getByText("Reconcile the provider receipt before authorizing another call")
    .waitFor();
  await ops.getByRole("button", { name: "Acknowledge" }).waitFor();
  assert.match(await ops.locator("main").innerText(), /stale/);
  passed.push(
    "R01/R02/R04-B stored readiness age, ambiguous attempts, cost uncertainty and incident recovery visible",
  );
  await ops.close();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  let posts = 0;
  await page.route("**/api/**", (route) => {
    if (route.request().method() === "POST") posts++;
    return route.fulfill({
      status: 503,
      contentType: "application/json",
      body: "{}",
    });
  });
  await page.goto(`${origin}/demo`);
  await page
    .getByText(/sample|illustrative|simulation/i)
    .first()
    .waitFor();
  await page.reload();
  await page
    .getByText(/sample|illustrative|simulation/i)
    .first()
    .waitFor();
  assert.equal(posts, 0);
  passed.push(
    "R07-B mobile sample survives reload without measurement requests",
  );
  await page.close();
  const manifest = {
    suite: "actual-next-browser-controlled-api",
    executed_at: new Date().toISOString(),
    passed,
    paid_requests: 0,
    qualification:
      "Actual Chromium and Next app with isolated API fixtures. Hosted authenticated customer/Storage acceptance and the complete browser case inventory remain separate.",
  };
  await writeFile(
    "docs/audits/2026-10-16/repair-browser-evidence.json",
    JSON.stringify(manifest, null, 2) + "\n",
  );
  console.log(JSON.stringify(manifest, null, 2));
} finally {
  await browser.close();
}
