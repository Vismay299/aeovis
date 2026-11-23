/** Rank Tracking: one weekly tracker for brightwave.io in India with eight weeks of history. */
import { DOMAIN, daysAgo, stable } from "./brand.js";

const CONFIG_ID = "e1000000-0000-4000-8000-000000000001";
const KEYWORDS = [
  ["hospital analytics software", 2900, 34, 1.9, 6, 3],
  ["nabh accreditation software", 1300, 29, 2.4, 9, 4],
  ["nabh quality indicators list", 2400, 22, 0.8, 4, 2],
  ["readmission rate calculation", 1900, 18, 0.6, 12, 7],
  ["hospital kpi dashboard", 1600, 31, 1.7, 15, 8],
  ["length of stay dashboard", 590, 26, 1.4, 21, 11],
  ["hospital bi tools", 480, 38, 2.2, 24, 14],
  ["clinical quality indicators nabh", 880, 20, 0.9, 7, 5],
  ["patient readmission software", 320, 33, 2.8, null, 18],
  ["healthcare analytics companies india", 720, 41, 1.6, 19, 12],
];
const RUNS = 8;
const kwId = (i) => `e2000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;
const runId = (n) => `e3000000-0000-4000-8000-${String(n + 1).padStart(12, "0")}`;
const runAt = (n) => daysAgo((RUNS - 1 - n) * 7 + 2, 5, 12);

/** Position of keyword `i` at run `n` (0 oldest): drifts from `start` to `end` with a little noise. */
function position(i, n, device) {
  const [, , , , start, end] = KEYWORDS[i];
  if (start === null && n < 4) return null;
  const from = start ?? end + 6;
  const raw = from + ((end - from) * n) / (RUNS - 1) + (stable(`${i}${n}${device}`) - 0.5) * 2 + (device === "desktop" ? -1 : 0);
  return Math.max(1, Math.round(raw));
}

function tracker() {
  return {
    id: CONFIG_ID, domain: DOMAIN, locationCode: 2356, languageCode: "en", locationName: null, devices: "both", serpDepth: 40,
    scheduleInterval: "weekly", nextCheckAt: daysAgo(-5, 5, 12), lastCheckedAt: runAt(RUNS - 1), lastSkipReason: null, lastSkipMessage: null,
    approvedMaxUsd: 2, keywordCount: KEYWORDS.length, lastRunStatus: "completed", lastRunCompletedAt: runAt(RUNS - 1),
  };
}

export const trackers = () => ({ trackers: [tracker()] });
export const config = (id) => (id === CONFIG_ID ? { tracker: tracker() } : undefined);

function latestRun() {
  return { id: runId(RUNS - 1), status: "completed", trigger: "scheduled", method: "queued", keywordsTotal: KEYWORDS.length, keywordsChecked: KEYWORDS.length, startedAt: runAt(RUNS - 1), completedAt: runAt(RUNS - 1), errorCode: null, errorMessage: null, pollAfterSeconds: null, lastCheckedAt: runAt(RUNS - 1), maybeStale: false };
}
export const runsLatest = (id) => (id === CONFIG_ID ? { run: latestRun() } : undefined);

export function results(id) {
  if (id !== CONFIG_ID) return undefined;
  const rows = KEYWORDS.map(([keyword, sv, kd, cpc], i) => {
    const device = (d) => ({
      position: position(i, RUNS - 1, d), previousPosition: position(i, RUNS - 2, d),
      rankingUrl: `https://${DOMAIN}${["/platform", "/nabh-reporting", "/blog/nabh-quality-indicators", "/blog/readmission-benchmarks-india", "/blog/hospital-kpi-dashboard", "/length-of-stay"][i % 6]}`,
      serpFeatures: i % 3 === 0 ? ["ai_overview", "people_also_ask"] : ["people_also_ask"], checkedAt: runAt(RUNS - 1),
    });
    return { trackingKeywordId: kwId(i), keyword, matchCase: false, pinned: i < 2, searchVolume: sv, keywordDifficulty: kd, cpc, desktop: device("desktop"), mobile: device("mobile"), aiQuestion: null };
  });
  return { rows, run: latestRun() };
}

export function trend(id, url) {
  if (id !== CONFIG_ID) return undefined;
  const device = url.searchParams.get("device") || "mobile";
  return {
    points: Array.from({ length: RUNS }, (_, n) => {
      const pos = KEYWORDS.map((_, i) => position(i, n, device));
      const top3 = pos.filter((p) => p && p <= 3).length;
      const top4to10 = pos.filter((p) => p && p > 3 && p <= 10).length;
      const top11to20 = pos.filter((p) => p && p > 10 && p <= 20).length;
      return { runId: runId(n), checkedAt: runAt(n), top3, top4to10, top11to20, notRanking: KEYWORDS.length - top3 - top4to10 - top11to20, notChecked: 0, aiOverview: 4, checked: KEYWORDS.length };
    }),
  };
}

export function matrix(id, url) {
  if (id !== CONFIG_ID) return undefined;
  const device = url.searchParams.get("device") || "mobile";
  return { cells: Array.from({ length: RUNS }, (_, n) => KEYWORDS.map((_, i) => ({ runId: runId(n), checkedAt: runAt(n), trackingKeywordId: kwId(i), position: position(i, n, device) }))).flat() };
}

export function history(id, keywordId) {
  const i = KEYWORDS.findIndex((_, k) => kwId(k) === keywordId);
  if (id !== CONFIG_ID || i < 0) return undefined;
  return { points: Array.from({ length: RUNS }, (_, n) => ["desktop", "mobile"].map((d) => ({ device: d, checkedAt: runAt(n), position: position(i, n, d) }))).flat() };
}

export function suggestions() {
  return { keywords: KEYWORDS.map(([keyword, searchVolume, keywordDifficulty, cpc], i) => ({ keyword, position: position(i, RUNS - 1, "mobile"), searchVolume, traffic: Math.round(searchVolume * 0.08), cpc, keywordDifficulty })), cached: true, fetchedAt: daysAgo(1) };
}
