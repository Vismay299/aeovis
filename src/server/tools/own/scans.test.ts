import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../../../shared/http/appError.ts";
import {
  createRunScanTool,
  getScanAnswerTool,
  getScanReportTool,
  getScanSourcesTool,
  getScanStatusTool,
} from "./scans.ts";
import type { ToolHandlerContext } from "../types.ts";

type Row = Record<string, any>;

function fakeAdmin(tables: Record<string, Row[]>) {
  const calls: string[] = [];
  const admin = {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const state = { limit: 0, columns: "" };
      const query: any = {
        select(columns: string) {
          state.columns = columns;
          calls.push(table + ".select:" + columns);
          return query;
        },
        eq(column: string, value: unknown) {
          filters.push([column, value]);
          calls.push(table + ".eq:" + column + "=" + String(value));
          return query;
        },
        in(column: string, values: unknown[]) {
          filters.push([column, values]);
          calls.push(table + ".in:" + column);
          return query;
        },
        order() {
          return query;
        },
        limit(n: number) {
          state.limit = n;
          return query;
        },
        maybeSingle() {
          const row =
            (tables[table] ?? []).find((candidate) =>
              filters.every(([key, value]) =>
                Array.isArray(value) ? value.includes(candidate[key]) : candidate[key] === value,
              ),
            ) ?? null;
          return Promise.resolve({ data: row, error: null });
        },
        then(resolve: (value: any) => unknown, reject: (error: unknown) => unknown) {
          let rows = (tables[table] ?? []).filter((candidate) =>
            filters.every(([key, value]) =>
              Array.isArray(value) ? value.includes(candidate[key]) : candidate[key] === value,
            ),
          );
          if (state.limit) rows = rows.slice(0, state.limit);
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  } as any;

  const context = {
    admin,
    brand: {
      brandKey: "brand-a",
      role: "owner",
      display_name: "A",
      website: "https://a.test",
      website_host: "a.test",
      aliases: [],
      is_active: true,
    },
    userId: "user",
    user: { id: "user", email: "" },
    role: "owner",
    requestId: "test",
    source: "test",
  } as ToolHandlerContext;

  return { context, calls };
}

const SCAN = "9e8d0000-0000-4000-8000-000000000001";
const RESULT = "6a1f0000-0000-4000-8000-000000000001";

test("foreign scan refusal happens before reading prompt results", async () => {
  const { context, calls } = fakeAdmin({
    scans: [{ id: SCAN, brand_key: "brand-b", raw_results: {} }],
    prompt_results: [{ id: RESULT, scan_id: SCAN }],
  });

  await assert.rejects(
    () => getScanReportTool.handler(context, { scanId: SCAN }),
    (error) => error instanceof AppError && error.code === "scan_not_found",
  );

  assert.ok(calls.includes("scans.eq:id=" + SCAN));
  assert.ok(calls.includes("scans.eq:brand_key=brand-a"));
  assert.equal(calls.some((call) => call.startsWith("prompt_results.")), false);
});

test("foreign answer refusal happens before selecting answer text", async () => {
  const { context, calls } = fakeAdmin({
    prompt_results: [{ id: RESULT, scan_id: SCAN, answer_text: "private answer" }],
    scans: [{ id: SCAN, brand_key: "brand-b" }],
  });

  await assert.rejects(
    () => getScanAnswerTool.handler(context, { resultId: RESULT }),
    (error) => error instanceof AppError && error.code === "scan_not_found",
  );

  assert.ok(calls.includes("scans.eq:id=" + SCAN));
  assert.ok(calls.includes("scans.eq:brand_key=brand-a"));
  assert.equal(
    calls.some(
      (call) =>
        call.startsWith("prompt_results.select:") && call.includes("answer_text"),
    ),
    false,
  );
});

test("onlyGaps keeps absent-brand rows with a named competitor and omits answer text", async () => {
  const { context, calls } = fakeAdmin({
    scans: [
      {
        id: SCAN,
        brand_key: "brand-a",
        scanned_at: "2026-11-01",
        visibility_pct: 50,
        raw_results: {
          planned_questions: 3,
          engines: ["chatgpt"],
          competitors: ["Rival"],
        },
      },
    ],
    prompt_results: [
      {
        id: RESULT,
        scan_id: SCAN,
        query: "q1",
        engine: "chatgpt",
        answered: true,
        mentioned: false,
        brand_cited: false,
        position: 1,
        raw: { brands: [{ name: "Rival", is_self: false, mentioned: true }] },
        answer_text: "secret answer",
      },
      {
        id: "6a1f0000-0000-4000-8000-000000000002",
        scan_id: SCAN,
        query: "q2",
        engine: "chatgpt",
        answered: true,
        mentioned: true,
        raw: { brands: [{ name: "Rival", mentioned: true }] },
      },
      {
        id: "6a1f0000-0000-4000-8000-000000000003",
        scan_id: SCAN,
        query: "q3",
        engine: "chatgpt",
        answered: false,
        mentioned: false,
        raw: { brands: [] },
      },
    ],
  });

  const output = (await getScanReportTool.handler(context, {
    scanId: SCAN,
    onlyGaps: true,
  })) as any;

  assert.equal(output.rows.length, 1);
  assert.equal(output.rows[0].resultId, RESULT);
  assert.equal(output.rows[0].competitorsNamed[0], "Rival");
  assert.equal(JSON.stringify(output).includes("secret answer"), false);

  const selection = calls.find((call) => call.startsWith("prompt_results.select:"));
  assert.ok(selection);
  assert.equal(selection.includes("answer_text"), false);
});

test("scan answer is truncated at 6,000 characters", async () => {
  const answerText = "x".repeat(6100);
  const { context } = fakeAdmin({
    prompt_results: [
      {
        id: RESULT,
        scan_id: SCAN,
        query: "q",
        engine: "chatgpt",
        answered: true,
        mentioned: false,
        brand_cited: false,
        answer_text: answerText,
      },
    ],
    scans: [{ id: SCAN, brand_key: "brand-a" }],
  });

  const answer = (await getScanAnswerTool.handler(context, {
    resultId: RESULT,
  })) as any;

  assert.equal(answer.answer.length, 6000);
  assert.equal(answer.truncated, true);
});

test("scan sources group domains and count distinct citing answers", async () => {
  const { context } = fakeAdmin({
    scans: [{ id: SCAN, brand_key: "brand-a" }],
    citations: [
      {
        domain: "docs.example.test",
        url: "https://docs.example.test/a",
        brand: "brand-a",
        scan_id: SCAN,
        result_id: RESULT,
        engine: "chatgpt",
        is_self: false,
      },
      {
        domain: "docs.example.test",
        url: "https://docs.example.test/b",
        brand: "brand-a",
        scan_id: SCAN,
        result_id: RESULT,
        engine: "gemini",
        is_self: false,
      },
      {
        domain: "docs.example.test",
        url: "https://docs.example.test/c",
        brand: "brand-a",
        scan_id: SCAN,
        result_id: "r2",
        engine: "gemini",
        is_self: false,
      },
    ],
  });

  const output = (await getScanSourcesTool.handler(context, { scanId: SCAN })) as any;

  assert.equal(output.totalCount, 1);
  assert.equal(output.sources[0].answersCiting, 2);
  assert.deepEqual(output.sources[0].engines, ["chatgpt", "gemini"]);
});

test("get_scan_status reads the finished scan from scan_jobs.result_id", async () => {
  const JOB = "11111111-1111-4111-8111-111111111111";
  const { context, calls } = fakeAdmin({
    scan_jobs: [{ id: JOB, brand_key: "brand-a", status: "complete", progress_pct: 100, result_id: SCAN }],
  });

  const output = (await getScanStatusTool.handler(context, { jobId: JOB })) as any;

  assert.equal(output.scanId, SCAN);
  assert.equal(output.progressPct, 100);
  assert.ok(calls.some((call) => call === "scan_jobs.select:id,brand_key,status,progress_pct,result_id"));
});

test("run_scan refuses without maxUsd before it quotes or starts anything", async () => {
  let quotes = 0;
  let starts = 0;
  const tool = createRunScanTool({
    requireApprovedPrice: (async () => {
      quotes += 1;
      return { quote: {}, approvedMaxUsd: 1, source: "dialog" };
    }) as any,
    startCustomerScan: (async () => {
      starts += 1;
      return { jobId: "job-1", approvedMaxUsd: 1, quotedUsd: 1 };
    }) as any,
  });

  await assert.rejects(() => tool.handler({} as any, { panelKey: "default" }));
  assert.equal(quotes, 0);
  assert.equal(starts, 0);
});

test("run_scan quotes the scan before starting it and passes the approved maximum", async () => {
  const { context } = fakeAdmin({});
  const order: string[] = [];
  let startArgs: any;

  const tool = createRunScanTool({
    requireApprovedPrice: (async (key: string, _ctx: any, quoteInput: any, maxUsd: number) => {
      order.push("quote");
      assert.equal(key, "ai_visibility.scan.run");
      assert.deepEqual(quoteInput, { panelKey: "default" });
      assert.equal(maxUsd, 0.5);
      return { quote: { totalUsd: 0.4 }, approvedMaxUsd: maxUsd, source: "dialog" };
    }) as any,
    startCustomerScan: (async (args: any) => {
      order.push("start");
      startArgs = args;
      return { jobId: "job-42", approvedMaxUsd: args.approvedMaxUsd, quotedUsd: 0.4 };
    }) as any,
  });

  const output = (await tool.handler(context, { maxUsd: 0.5 })) as any;

  assert.deepEqual(order, ["quote", "start"]);
  assert.deepEqual(output, { jobId: "job-42", status: "pending", approvedMaxUsd: 0.5 });
  assert.equal(startArgs.brandKey, "brand-a");
  assert.equal(startArgs.userId, "user");
  assert.equal(startArgs.panelKey, "default");
  assert.equal(startArgs.brandDisplayName, "A");
  assert.equal(startArgs.url, "https://a.test");
});
