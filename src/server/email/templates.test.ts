import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  TEMPLATE_KEYS,
  validateTemplateData,
  buildScanFinishedData,
  buildScheduleSkippedData,
  buildSpendCapData,
} from "./templates.ts";
import { AppError } from "../../shared/http/errors.ts";

const FIXTURES_DIR = path.resolve(process.cwd(), "tests/fixtures/f25");

test("buildScanFinishedData produces exactly allowed keys and leaks no answer text, competitors, or questions", async () => {
  const rawScanJson = await readFile(path.join(FIXTURES_DIR, "scan-row.json"), "utf8");
  const scan = JSON.parse(rawScanJson);

  const brand = {
    brand_key: "acme-corp",
    display_name: "Acme Corporation",
  };
  const links = {
    appUrl: "https://app.perceev.com",
    reportUrl: "https://app.perceev.com/portal/scans/550e8400-e29b-41d4-a716-446655440000",
    unsubscribeUrl: "https://app.perceev.com/email/unsubscribe?u=user1&c=scan_results&t=sig123",
  };

  const data = buildScanFinishedData(scan, brand, links);
  const keys = Object.keys(data).sort();
  const expectedKeys = [...TEMPLATE_KEYS.scan_finished].sort();
  assert.deepEqual(keys, expectedKeys);

  // Assert honest numbers
  assert.equal(data.questionsAsked, "30");
  assert.equal(data.questionsNamingYou, "12");
  assert.equal(data.outcomeLabel, "Complete");
  assert.equal(data.scanDate, "22 Oct 2026");

  // Walk all string values and verify none of the sensitive strings from scan-row.json leaked
  const sensitiveStrings = [
    "ACME is the best",
    "CompetitorX",
    "CompetitorY",
    "What is the best CRM software for startups?",
    "https://competitorx.example.com",
  ];

  for (const [k, v] of Object.entries(data)) {
    for (const secret of sensitiveStrings) {
      assert.ok(
        !v.includes(secret),
        `Template field ${k} leaked sensitive content: ${secret}`,
      );
    }
  }
});

test("buildScanFinishedData: prompts_mentioned null -> 'Not measured', 0 -> '0'", () => {
  const brand = { brand_key: "acme", display_name: "Acme" };
  const links = {
    appUrl: "https://app.perceev.com",
    reportUrl: "https://app.perceev.com/portal/scans/s1",
    unsubscribeUrl: "https://app.perceev.com/unsub",
  };

  // Null case
  const scanNull = {
    id: "s1",
    created_at: "2026-10-22T00:00:00Z",
    prompts_tracked: null,
    prompts_mentioned: null,
    raw_results: null,
  };
  const dataNull = buildScanFinishedData(scanNull, brand, links);
  assert.equal(dataNull.questionsAsked, "Not measured");
  assert.equal(dataNull.questionsNamingYou, "Not measured");
  assert.equal(dataNull.outcomeLabel, "Partial — some answers could not be collected");

  // Zero case
  const scanZero = {
    id: "s2",
    created_at: "2026-10-22T00:00:00Z",
    prompts_tracked: 25,
    prompts_mentioned: 0,
    raw_results: { summary_stats: { terminal_outcome: { outcome: "complete" } } },
  };
  const dataZero = buildScanFinishedData(scanZero, brand, links);
  assert.equal(dataZero.questionsAsked, "25");
  assert.equal(dataZero.questionsNamingYou, "0");
  assert.equal(dataZero.outcomeLabel, "Complete");
});

test("buildScheduleSkippedData produces exactly allowed keys and correct action routing", () => {
  const brand = { brand_key: "acme", display_name: "Acme" };
  const links = {
    appUrl: "https://app.perceev.com",
    unsubscribeUrl: "https://app.perceev.com/unsub",
  };

  // 1. panel_not_approved -> Approve your questions -> /portal/measurement
  const dataPanel = buildScheduleSkippedData(
    {
      window_time: "2026-10-22T14:00:00Z",
      reason: "panel_not_approved",
    },
    brand,
    "2026-10-23T14:00:00Z",
    links,
  );
  assert.deepEqual(Object.keys(dataPanel).sort(), [...TEMPLATE_KEYS.schedule_skipped].sort());
  assert.equal(dataPanel.actionLabel, "Approve your questions");
  assert.equal(dataPanel.actionUrl, "https://app.perceev.com/portal/measurement");
  assert.equal(dataPanel.windowTime, "22 Oct 2026, 14:00 UTC");
  assert.equal(dataPanel.nextRunTime, "23 Oct 2026, 14:00 UTC");

  // 2. price_changed -> Review the price -> /portal/settings/schedule
  const dataPrice = buildScheduleSkippedData(
    {
      window_time: "2026-10-22T14:00:00Z",
      reason: "price_changed",
    },
    brand,
    null,
    links,
  );
  assert.equal(dataPrice.actionLabel, "Review the price");
  assert.equal(dataPrice.actionUrl, "https://app.perceev.com/portal/settings/schedule");
  assert.equal(dataPrice.nextRunTime, "Not scheduled");

  // 3. other reason -> View schedule -> /portal/settings/schedule
  const dataOther = buildScheduleSkippedData(
    {
      window_time: "2026-10-22T14:00:00Z",
      reason: "scheduling_disabled",
    },
    brand,
    null,
    links,
  );
  assert.equal(dataOther.actionLabel, "View schedule");
  assert.equal(dataOther.actionUrl, "https://app.perceev.com/portal/settings/schedule");
});

test("buildSpendCapData produces allowed keys and correct period/date formatting", () => {
  const brand = { brand_key: "acme", display_name: "Acme" };
  const links = {
    appUrl: "https://app.perceev.com",
    unsubscribeUrl: "https://app.perceev.com/unsub",
  };

  // Daily cap
  const dataDaily = buildSpendCapData(
    {
      reason: "daily_cap",
      limitUsd: 15.5,
      now: new Date("2026-10-22T14:00:00Z"),
      usagePageEnabled: true,
    },
    brand,
    links,
  );
  assert.deepEqual(Object.keys(dataDaily).sort(), [...TEMPLATE_KEYS.spend_cap_reached].sort());
  assert.equal(dataDaily.periodLabel, "daily");
  assert.equal(dataDaily.limitUsd, "$15.50");
  assert.equal(dataDaily.resumesOn, "23 Oct 2026");
  assert.equal(dataDaily.usageUrl, "https://app.perceev.com/portal/usage");

  // Monthly cap with usage page disabled
  const dataMonthly = buildSpendCapData(
    {
      reason: "workspace_cap",
      limitUsd: 250,
      now: new Date("2026-10-22T14:00:00Z"),
      usagePageEnabled: false,
    },
    brand,
    links,
  );
  assert.equal(dataMonthly.periodLabel, "monthly");
  assert.equal(dataMonthly.limitUsd, "$250.00");
  assert.equal(dataMonthly.resumesOn, "1 Nov 2026");
  assert.equal(dataMonthly.usageUrl, "https://app.perceev.com/portal");

  // Unknown limit
  const dataUnknown = buildSpendCapData(
    {
      reason: "daily_cap",
      limitUsd: null,
      now: new Date("2026-10-22T14:00:00Z"),
    },
    brand,
    links,
  );
  assert.equal(dataUnknown.limitUsd, "your limit");
});

test("validateTemplateData throws email_data_invalid on invalid keys, types, lengths, or patterns", () => {
  // Unknown key
  assert.throws(
    () => {
      validateTemplateData("scan_finished", {
        brandName: "Acme",
        scanDate: "22 Oct 2026",
        questionsAsked: "10",
        questionsNamingYou: "5",
        outcomeLabel: "Complete",
        reportUrl: "https://app.perceev.com/portal/scans/123",
        unsubscribeUrl: "https://app.perceev.com/unsub",
        extraUnauthorizedKey: "bad",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "email_data_invalid");
      return true;
    },
  );

  // Non-string value
  assert.throws(
    () => {
      validateTemplateData("scan_finished", {
        brandName: "Acme",
        scanDate: "22 Oct 2026",
        questionsAsked: 10,
        questionsNamingYou: "5",
        outcomeLabel: "Complete",
        reportUrl: "https://app.perceev.com/portal/scans/123",
        unsubscribeUrl: "https://app.perceev.com/unsub",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "email_data_invalid");
      return true;
    },
  );

  // Value > 200 chars
  assert.throws(
    () => {
      validateTemplateData("scan_finished", {
        brandName: "Acme",
        scanDate: "22 Oct 2026",
        questionsAsked: "10",
        questionsNamingYou: "5",
        outcomeLabel: "Complete",
        reportUrl: "https://app.perceev.com/" + "a".repeat(200),
        unsubscribeUrl: "https://app.perceev.com/unsub",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "email_data_invalid");
      return true;
    },
  );

  // Pattern mismatch
  assert.throws(
    () => {
      validateTemplateData("scan_finished", {
        brandName: "Acme",
        scanDate: "invalid-date-format",
        questionsAsked: "10",
        questionsNamingYou: "5",
        outcomeLabel: "Complete",
        reportUrl: "https://app.perceev.com/portal/scans/123",
        unsubscribeUrl: "https://app.perceev.com/unsub",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "email_data_invalid");
      return true;
    },
  );
});
