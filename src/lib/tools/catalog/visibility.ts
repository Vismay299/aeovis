import { defineRegistration, type ToolRegistration } from "../types.ts";
import { getMeasurementStatusTool } from "../own/measurement.ts";
import {
  getScanAnswerTool,
  getScanReportTool,
  getScanSourcesTool,
  getScanStatusTool,
  listScansTool,
} from "../own/scans.ts";
import {
  getQuestionAnswerTool,
  getQuestionHistoryTool,
} from "../own/questionsHistory.ts";

const questionId = "0b9c2d4e-6f70-4a81-9b2c-3d4e5f607182";
const answerId = "6a1f0000-0000-4000-8000-000000000001";
const scanId = "9e8d0000-0000-4000-8000-000000000001";

const execution = {
  answerId,
  source: "scan",
  engine: "chatgpt",
  engineLabel: "ChatGPT",
  collectedAt: "2026-10-20T10:12:04.000Z",
  trigger: "manual",
  status: "answered",
  ownMentioned: false,
  ownCited: false,
  askedText: "sample question",
  scanId,
  exploreRunId: null,
  method: "model_api",
  quality: "measured",
};

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: true,
};

function registration(
  def: any,
  example: any,
  summarize: (output: any, input: any) => string,
  path?: (output: any, input: any) => string,
  extra: Partial<ToolRegistration> = {},
): ToolRegistration {
  return defineRegistration({
    def,
    area: "visibility",
    feature: null,
    effect: "read",
    approval: () => ({ kind: "none" }),
    annotations,
    summarize,
    link: path
      ? (output: any, input: any) => ({
          path: path(output, input),
          label: "View details",
        })
      : undefined,
    ...extra,
    example,
  } as ToolRegistration);
}

export const registrations: ToolRegistration[] = [
  registration(
    getMeasurementStatusTool,
    {
      input: {},
      output: {
        panel: {
          approvedVersion: null,
          dirty: false,
          active: 0,
          branded: 0,
        },
        schedule: null,
        latestScans: [],
        enginesConfigured: [],
      },
    },
    (output) =>
      "Measurement: " +
      (output?.panel?.active ?? 0) +
      " active questions; " +
      (output?.latestScans?.length ?? 0) +
      " recent scans.",
    () => "/portal/measurement",
  ),
  registration(
    listScansTool,
    {
      input: { limit: 10 },
      output: { scans: [], totalCount: 0 },
    },
    (output) => (output?.scans?.length ?? 0) + " recent scans.",
    () => "/portal/scans",
  ),
  registration(
    getScanReportTool,
    {
      input: { scanId },
      output: {
        scan: {
          scanId,
          scannedAt: null,
          visibilityPct: null,
          engines: null,
          competitors: [],
        },
        rows: [],
        totalCount: 0,
        coverage: {
          planned: null,
          answered: 0,
          notAnswered: 0,
          failed: 0,
        },
      },
    },
    (output) => "Scan report: " + (output?.rows?.length ?? 0) + " answers.",
    (output) => "/portal/scans/" + (output?.scan?.scanId ?? ""),
  ),
  registration(
    getScanAnswerTool,
    {
      input: { resultId: answerId },
      output: {
        resultId: answerId,
        scanId,
        question: "sample question",
        engine: "chatgpt",
        answered: true,
        mentioned: false,
        cited: false,
        answer: "A sample answer.",
        truncated: false,
      },
    },
    (output) => "Answer for " + (output?.question ?? "scan question") + ".",
    (output) => "/portal/scans/" + (output?.scanId ?? ""),
    { untrustedPaths: ["answer"] },
  ),
  registration(
    getScanSourcesTool,
    {
      input: { scanId },
      output: {
        sources: [],
        totalCount: 0,
        note: "Counts are answers in this scan that cited the domain.",
      },
    },
    (output) => (output?.sources?.length ?? 0) + " cited domains.",
    (_output, input) => "/portal/scans/" + (input?.scanId ?? ""),
    { untrustedPaths: ["sources[*].exampleUrl"] },
  ),
  registration(
    getScanStatusTool,
    {
      input: { jobId: scanId },
      output: {
        jobId: scanId,
        status: "completed",
        progressPct: 100,
        scanId,
      },
    },
    (output) => "Scan job " + (output?.status ?? "unknown") + ".",
    () => "/portal/scans",
    {
      waitForProgress: {
        statusPath: "status",
        runningValues: ["pending", "running"],
        progressPath: "progressPct",
        budgetMs: 45_000,
      },
    },
  ),
  registration(
    getQuestionHistoryTool,
    {
      input: { questionId },
      output: {
        question: {
          id: questionId,
          text: "sample question",
          topic: null,
          status: "active",
          branded: false,
          origin: "manual",
          replacedBy: null,
          replaces: [],
        },
        range: { from: null, to: null },
        executions: [],
        summary: [],
        coverage: {
          total: 0,
          answered: 0,
          noAnswer: 0,
          failed: 0,
          explore: 0,
          legacy: 0,
        },
        truncated: false,
        latestScanId: null,
      },
    },
    (output) =>
      (output?.coverage?.total ?? 0) + " recorded question answers.",
    (output) => "/portal/questions/" + (output?.question?.id ?? questionId),
  ),
  registration(
    getQuestionAnswerTool,
    {
      input: { questionId, answerId },
      output: {
        execution,
        text: null,
        markdown: null,
        truncated: false,
        citations: [],
        brands: [],
        provenance: {
          method: "unknown",
          methodLabel: "Unknown method",
          gateway: null,
          requestedModel: null,
          returnedModel: null,
          requestedLocation: null,
          searchUsed: "unknown",
        },
        evidence: { state: "none", captures: [] },
        error: null,
      },
    },
    (output) =>
      "Answer for " + (output?.execution?.engineLabel ?? "question") + ".",
    (_output, input) => "/portal/questions/" + input.questionId,
    { untrustedPaths: ["text", "markdown"] },
  ),
];
