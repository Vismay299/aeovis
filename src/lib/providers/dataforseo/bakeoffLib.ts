// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ai-visibility/services/aiVisibilityMatching.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { lstatSync, realpathSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { aiAnswerUsd, llmResponseUsd } from "../../../shared/ai-visibility-pricing.ts";
import type { AiEngine } from "../../../shared/ai-visibility-pricing.ts";

const DEFAULT_ARMS = ["dfs_queued", "dfs_live"];
const ALL_ARMS = new Set(["dfs_queued", "dfs_live", "dfs_model", "current"]);
const ENGINE_SETS: Record<string, string[]> = {
  dfs_queued: ["chatgpt", "gemini", "google_ai_overview"],
  dfs_live: ["chatgpt", "gemini", "google_ai_overview"],
  dfs_model: ["perplexity"],
  current: ["aio", "chatgpt", "gemini", "perplexity"],
};

type BakeoffArgs = {
  panel: string | null;
  runId?: string;
  arms: string[];
  competitors: string[];
  reserveUsd: number;
  maxRequests: number;
  maxSpendUsd: number;
  out?: string;
  confirmSpend: number | null;
  perplexityQuestions: number;
  dryRun: boolean;
  selfTest: boolean;
};
type BakeoffPanel = {
  context: { country: string; language: string; website?: string };
  prompts: Array<{ text: string; purpose?: string | null }>;
};
type PlannedItem = { arm: string; engine: string; questionIndex: number; purpose: string | null; requestUnits: number };
type DataRecord = Record<string, any>;
type BakeoffMetric = Record<string, any>;

function refusal(message: string): Error & { exitCode: number } {
  const error = new Error(message);
  return Object.assign(error, { exitCode: 2 });
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

function resolveRealPath(candidate: string): string {
  let current = path.resolve(candidate);
  const suffix: string[] = [];
  while (true) {
    try {
      return path.resolve(realpathSync(current), ...suffix);
    } catch (error) {
      if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTDIR") {
        throw refusal("--out path cannot be resolved safely");
      }
      try {
        if (lstatSync(current).isSymbolicLink()) {
          throw refusal("--out path contains an unresolved link");
        }
      } catch (statError) {
        if (statError && typeof statError === "object" && "exitCode" in statError) throw statError;
        if (errorCode(statError) !== "ENOENT" && errorCode(statError) !== "ENOTDIR") {
          throw refusal("--out path cannot be resolved safely");
        }
      }
      const parent = path.dirname(current);
      if (parent === current) throw refusal("--out path cannot be resolved safely");
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(".." + path.sep) &&
      !path.isAbsolute(relative));
}

function isGoogleDrivePath(candidate: string): boolean {
  return candidate.toLowerCase().replace(/\\/g, "/").includes("/my drive/");
}

function assertOutputOutsideRepository(output: string, cwd: string): string {
  const root = resolveRealPath(cwd);
  const resolvedOutput = resolveRealPath(path.resolve(cwd, output));
  if (isWithin(root, resolvedOutput)) throw refusal("--out must be outside the repository");
  if (isGoogleDrivePath(output) || isGoogleDrivePath(resolvedOutput)) {
    throw refusal("--out must be outside Google Drive");
  }
  return resolvedOutput;
}

export async function createPrivateOutputDirectory(output: string, cwd = process.cwd()): Promise<string> {
  const requested = path.resolve(cwd, output);
  assertOutputOutsideRepository(output, cwd);
  await mkdir(path.dirname(requested), { recursive: true, mode: 0o700 });
  try {
    await mkdir(requested, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) === "EEXIST") throw refusal("run id already exists under --out");
    throw error;
  }
  const realOutput = realpathSync(requested);
  assertOutputOutsideRepository(realOutput, cwd);
  return realOutput;
}

export function parseArgs(argv: string[] = []): BakeoffArgs {
  const values: Record<string, string | boolean | undefined> = {};
  const booleans = new Set(["dry-run", "self-test"]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith("--")) throw refusal("Unexpected positional argument");
    const name = flag.slice(2);
    if (booleans.has(name)) {
      if (values[name] !== undefined) throw refusal(`Duplicate --${name}`);
      values[name] = true;
      continue;
    }
    if (!["panel", "run-id", "arms", "competitors", "reserve-usd", "max-requests", "max-spend-usd", "out", "confirm-spend", "perplexity-questions"].includes(name)) throw refusal(`Unknown flag: --${name}`);
    const value: string | undefined = argv[++index];
    if (!value || value.startsWith("--")) throw refusal(`Missing value for --${name}`);
    if (values[name] !== undefined) throw refusal(`Duplicate --${name}`);
    values[name] = value;
  }
  if (!values.panel && !values["self-test"]) throw refusal("Missing --panel");
  const stringValue = (name: string): string | undefined => typeof values[name] === "string" ? values[name] as string : undefined;
  const number = (name: string, fallback: number) => stringValue(name) === undefined ? fallback : Number(stringValue(name));
  const args = {
    panel: stringValue("panel") ?? null,
    runId: stringValue("run-id"),
    arms: (stringValue("arms") ?? DEFAULT_ARMS.join(",")).split(","),
    competitors: (stringValue("competitors") ?? "").split(",").map((item) => item.trim()).filter(Boolean),
    reserveUsd: number("reserve-usd", 0.2),
    maxRequests: number("max-requests", 400),
    maxSpendUsd: number("max-spend-usd", 0.8),
    out: stringValue("out"),
    confirmSpend: stringValue("confirm-spend") === undefined ? null : Number(stringValue("confirm-spend")),
    perplexityQuestions: number("perplexity-questions", Number.POSITIVE_INFINITY),
    dryRun: values["dry-run"] === true,
    selfTest: values["self-test"] === true,
  };
  if (args.arms.length === 0 || args.arms.some((arm) => !ALL_ARMS.has(arm)) || new Set(args.arms).size !== args.arms.length) throw refusal("Invalid --arms");
  if (!(args.maxSpendUsd > 0 && args.maxSpendUsd <= 25)) throw refusal("Invalid --max-spend-usd");
  if (!Number.isInteger(args.maxRequests) || args.maxRequests < 1 || args.maxRequests > 600) throw refusal("Invalid --max-requests");
  if (!(args.reserveUsd > 0 && args.reserveUsd <= args.maxSpendUsd)) throw refusal("Invalid --reserve-usd");
  if (!(args.perplexityQuestions === Number.POSITIVE_INFINITY || (Number.isInteger(args.perplexityQuestions) && args.perplexityQuestions >= 1))) throw refusal("Invalid --perplexity-questions");
  if (!args.dryRun && args.confirmSpend !== args.maxSpendUsd) throw refusal("--confirm-spend must equal --max-spend-usd");
  if (args.runId && !/^[a-z0-9-]{8,60}$/.test(args.runId)) throw refusal("Invalid --run-id");
  return args;
}

export function assertEnvironment(env: Record<string, string | undefined> = process.env, cwd = process.cwd(), args: { out?: string } = {}): true {
  if (!env.PGHOST || !["127.0.0.1", "localhost", "::1"].includes(env.PGHOST)) throw refusal("PGHOST must be loopback");
  if (!/(?:_live_qa)$/.test(env.PGDATABASE ?? "")) throw refusal("PGDATABASE must end in _live_qa");
  for (const name of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "DATABASE_URL"]) {
    if (env[name] !== undefined) throw refusal(name + " must be unset");
  }
  if (args.out) assertOutputOutsideRepository(args.out, cwd);
  return true;
}

export async function probeCurrentProviderOnce(
  engine: { probe: (...args: any[]) => Promise<any> },
  query: unknown,
  brand: string,
  brandAliases: string[],
  brandDomain: string | null,
  competitors: unknown[],
  stats: Record<string, unknown>,
): Promise<any> {
  const methods = [
    "assert", "debug", "dir", "dirxml", "error", "group", "groupCollapsed",
    "info", "log", "table", "trace", "warn",
  ] as const;
  const originalDescriptors = new Map<(typeof methods)[number], PropertyDescriptor | undefined>();
  try {
    for (const method of methods) {
      const descriptor = Object.getOwnPropertyDescriptor(console, method);
      originalDescriptors.set(method, descriptor);
      Object.defineProperty(console, method, {
        configurable: true,
        enumerable: descriptor?.enumerable ?? true,
        writable: true,
        value: () => undefined,
      });
    }
    return await engine.probe(
      query,
      brand,
      brandAliases,
      brandDomain,
      competitors,
      stats,
      { durableDispatch: true },
    );
  } finally {
    for (const [method, descriptor] of originalDescriptors) {
      if (descriptor) Object.defineProperty(console, method, descriptor);
      else Reflect.deleteProperty(console, method);
    }
  }
}

export async function loadPanel(filePath: string): Promise<BakeoffPanel> {
  let panel: unknown;
  try { panel = JSON.parse(await readFile(filePath, "utf8")); }
  catch { throw refusal("Panel must be readable JSON"); }
  if (!panel || typeof panel !== "object" || Array.isArray(panel)) throw refusal("Panel must contain context and 1–60 prompts with text");
  const record = panel as Record<string, unknown>;
  const context = record.context as Record<string, unknown> | null;
  const prompts = record.prompts;
  if (!context || typeof context.country !== "string" || typeof context.language !== "string" || !Array.isArray(prompts) || prompts.length < 1 || prompts.length > 60 || prompts.some((prompt: unknown) => !prompt || typeof prompt !== "object" || typeof (prompt as Record<string, unknown>).text !== "string" || !(prompt as Record<string, string>).text.trim())) {
    throw refusal("Panel must contain context and 1–60 prompts with text");
  }
  return panel as BakeoffPanel;
}

export function planArms(panel: BakeoffPanel, args: BakeoffArgs): PlannedItem[] {
  const questions = panel.prompts.map((prompt, questionIndex) => ({ questionIndex, purpose: prompt.purpose ?? null }));
  return args.arms.flatMap((arm) => {
    const chosen = arm === "dfs_model" ? questions.slice(0, Math.min(questions.length, args.perplexityQuestions)) : questions;
    return ENGINE_SETS[arm].flatMap((engine) => chosen.map(({ questionIndex, purpose }) => ({ arm, engine, questionIndex, purpose, requestUnits: arm === "current" && engine === "aio" ? 2 : arm === "current" && engine === "perplexity" ? 2 : 1 })));
  });
}

export function estimatePlan(plan: PlannedItem[]): number {
  return plan.reduce((total, item) => total + (item.arm === "dfs_model" ? llmResponseUsd("perplexity", true) : aiAnswerUsd((item.engine === "aio" ? "google_ai_overview" : item.engine) as AiEngine, item.arm === "dfs_live" ? "live" : "queued")), 0);
}

export function createGuardedFetch({ allowHosts, maxRequests, dryRun = false, fetchImpl = fetch }: { allowHosts: string[]; maxRequests: number; dryRun?: boolean; fetchImpl?: typeof fetch }): typeof fetch & { readonly requestCount: number } {
  const allowed = new Set(allowHosts.map((host) => host.toLowerCase()));
  let requestCount = 0;
  const guarded = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    if (!allowed.has(url.hostname.toLowerCase())) throw new Error("Network destination refused");
    const sandbox = url.hostname === "sandbox.dataforseo.com";
    const catalogue = url.hostname === "api.dataforseo.com" && /\/models$/.test(url.pathname);
    if (dryRun && !sandbox && !catalogue) throw new Error("Dry run permits only sandbox and model catalogue requests");
    if (requestCount >= maxRequests) throw new Error("Request ceiling exceeded");
    requestCount += 1;
    return fetchImpl(input, init);
  }) as typeof fetch & { readonly requestCount: number };
  Object.defineProperty(guarded, "requestCount", { get: () => requestCount });
  return guarded;
}

function aiMentionSpans(text: string, names: string[]): { start: number; end: number }[] {
  const prose = text.replace(/(?:https?:\/\/|www\.)[^\s<>]+|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/giu, (value) => " ".repeat(value.length));
  let normalized = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (const character of prose) {
    const decomposed = character.normalize("NFD");
    normalized += decomposed;
    for (let index = 0; index < decomposed.length; index += 1) {
      starts.push(offset);
      ends.push(offset + character.length);
    }
    offset += character.length;
  }
  const found = new Map<string, { start: number; end: number }>();
  for (const name of new Set(names.map((item) => item.trim()).filter((item) => item.length >= 2))) {
    const escaped = name.normalize("NFD").replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    const pattern = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_])${escaped}(?![\\p{L}\\p{M}\\p{N}_])`, "giu");
    for (const match of normalized.matchAll(pattern)) {
      const start = starts[match.index];
      const end = ends[match.index + match[0].length - 1];
      found.set(`${start}:${end}`, { start, end });
    }
  }
  return [...found.values()].sort((a, b) => a.start - b.start || b.end - a.end).filter((span, index, all) =>
    !all.slice(0, index).some((other) => other.start <= span.start && other.end >= span.end),
  );
}

function safeRate(count: number, total: number) { return { count, total, rate: total ? count / total : null }; }
function finiteProvidedNumber(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === "string" && value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function timestampMillis(value: unknown): number | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  return null;
}
function queuedCollectionMinutes(observation: DataRecord): number | null {
  if (observation.collectionCompleted !== true) return null;
  const postedAt = timestampMillis(observation.postedAt);
  const resultAt = timestampMillis(observation.resultAt);
  if (postedAt !== null && resultAt !== null) {
    const elapsed = (resultAt - postedAt) / 60_000;
    return elapsed >= 0 ? elapsed : null;
  }
  return finiteProvidedNumber(observation.collectMinutes);
}
function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}
function jaccard(a: string[] = [], b: string[] = []): number {
  const left = new Set(a), right = new Set(b), union = new Set([...left, ...right]);
  return union.size ? [...left].filter((item) => right.has(item)).length / union.size : 1;
}

export function computeMetrics(observations: DataRecord[], answers: DataRecord[], roster: DataRecord[] = [], account: { balanceBeforeUsd?: number | null; balanceAfterUsd?: number | null } = {}): Record<string, BakeoffMetric> {
  const answerById = new Map(answers.map((answer) => [answer.observationId, answer]));
  const groups = new Map<string, Array<{ observation: DataRecord; answer: DataRecord }>>();
  for (const observation of observations) {
    const key = `${observation.arm}:${observation.engine}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ observation, answer: answerById.get(observation.id) ?? {} });
  }
  const brands = roster.length ? roster : [{ name: "Offcult", domain: "offcult.in" }];
  const output: Record<string, BakeoffMetric> = {};
  for (const [key, rows] of groups) {
    const answered = rows.filter(({ answer }) => typeof answer.answerText === "string" && answer.answerText.trim());
    const nonEmpty = answered.length;
    const mentioned = answered.filter(({ answer }) => Boolean(answer.brandMentioned)).length;
    const citationRows = answered.map(({ answer }) => answer.citations ?? []);
    const knownCosts = rows.map(({ observation }) => finiteProvidedNumber(observation.costUsd)).filter((value): value is number => value !== null);
    const costs = knownCosts.reduce((sum, value) => sum + value, 0);
    const expected = rows.reduce((sum, { observation }) => sum + (Number(observation.priceUsd) || 0), 0);
    const validSerpRows = rows.filter(({ observation }) => observation.validSerp === true);
    const validSerps = validSerpRows.length;
    const aios = validSerpRows.filter(({ observation }) => observation.aioPresent).length;
    const latencies = rows.filter(({ observation }) => observation.arm !== "dfs_queued").map(({ observation }) => Number(observation.latencyMs)).filter(Number.isFinite);
    const failures: Record<string, number> = {};
    const states: Record<string, number> = {};
    for (const { observation } of rows) {
      if (observation.state) states[observation.state] = (states[observation.state] ?? 0) + 1;
      if (observation.failureKind) failures[observation.failureKind] = (failures[observation.failureKind] ?? 0) + 1;
    }
    const parser = answered.filter(({ answer }) => answer.extractedMentioned !== undefined);
    const selfBrand = brands[0];
    const selfDomain = String(selfBrand.domain ?? "").replace(/^www\./i, "");
    const selfNames = [selfBrand.name, selfDomain, selfDomain.split(".")[0]].filter((value): value is string => typeof value === "string" && value.length > 0);
    const parserMatches = parser.filter(({ answer }) => Boolean(answer.extractedMentioned) === (aiMentionSpans(answer.answerText, selfNames).length > 0)).length;
    const balanceBefore = account.balanceBeforeUsd;
    const balanceAfter = account.balanceAfterUsd;
    output[key] = {
      arm: rows[0].observation.arm,
      engine: rows[0].observation.engine,
      sampleSize: rows.length,
      indiaAcceptance: safeRate(rows.filter(({ observation }) => observation.accepted).length, rows.filter(({ observation }) => observation.posted).length),
      echoedIndiaLocation: safeRate(rows.filter(({ observation }) => observation.echoedLocation).length, rows.filter(({ observation }) => observation.accepted).length),
      indiaDomainHeuristic: safeRate(answered.filter(({ answer }) => (answer.citations ?? []).some((citation: DataRecord) => citation.domain?.toLowerCase().endsWith(".in"))).length, nonEmpty),
      aiOverviewPresence: safeRate(aios, validSerps),
      asyncRefundObserved: (() => {
        const queuedGoogle = rows.filter(({ observation }) => observation.arm === "dfs_queued" && observation.engine === "google_ai_overview" && observation.posted === true && observation.accepted === true);
        return safeRate(queuedGoogle.filter(({ observation }) => {
          const cost = finiteProvidedNumber(observation.costUsd);
          return cost !== null && cost < 0.0012;
        }).length, queuedGoogle.length);
      })(),
      rejectedTasks: rows.filter(({ observation }) => observation.rejectedTask).length,
      rejectedStatusCodes: rows.reduce<Record<string, number>>((histogram, { observation }) => { if (observation.rejectedTask && observation.statusCode != null) histogram[observation.statusCode] = (histogram[observation.statusCode] ?? 0) + 1; return histogram; }, {}),
      noResults: rows.filter(({ observation }) => observation.noResults).length,
      answered: safeRate(nonEmpty, rows.length),
      emptyAnswer: safeRate(rows.length - nonEmpty, rows.length),
      offcultMention: safeRate(mentioned, nonEmpty),
      brandedMention: safeRate(answered.filter(({ answer }) => answer.branded && answer.brandMentioned).length, answered.filter(({ answer }) => answer.branded).length),
      nonBrandedMention: safeRate(answered.filter(({ answer }) => !answer.branded && answer.brandMentioned).length, answered.filter(({ answer }) => !answer.branded).length),
      meanCompetitorsNamed: nonEmpty ? answered.reduce((sum, { answer }) => sum + (answer.competitorsNamed ?? 0), 0) / nonEmpty : null,
      citationCoverage: safeRate(citationRows.filter((citations) => citations.length > 0).length, nonEmpty),
      meanCitations: nonEmpty ? citationRows.reduce((sum, citations) => sum + citations.length, 0) / nonEmpty : null,
      medianAnswerLength: percentile(answered.map(({ answer }) => answer.answerText.length), 0.5),
      parserAgreement: safeRate(parserMatches, parser.length),
      latencyMs: { p50: percentile(latencies, 0.5), p90: percentile(latencies, 0.9), max: latencies.length ? Math.max(...latencies) : null },
      queuedLatencyMinutes: (() => {
        const collectionTimes = rows.filter(({ observation }) => observation.arm === "dfs_queued" && observation.collectionEligible === true).map(({ observation }) => queuedCollectionMinutes(observation)).filter((value): value is number => value !== null);
        return { p50: percentile(collectionTimes, 0.5), p90: percentile(collectionTimes, 0.9), max: collectionTimes.length ? Math.max(...collectionTimes) : null };
      })(),
      collectedBy10Minutes: (() => {
        const eligible = rows.filter(({ observation }) => observation.arm === "dfs_queued" && observation.collectionEligible === true);
        const collectedByThreshold = eligible.filter(({ observation }) => {
          const minutes = queuedCollectionMinutes(observation);
          return minutes !== null && minutes <= 10;
        }).length;
        return safeRate(collectedByThreshold, eligible.length);
      })(),
      collectedBy30Minutes: (() => {
        const eligible = rows.filter(({ observation }) => observation.arm === "dfs_queued" && observation.collectionEligible === true);
        const collectedByThreshold = eligible.filter(({ observation }) => {
          const minutes = queuedCollectionMinutes(observation);
          return minutes !== null && minutes <= 30;
        }).length;
        return safeRate(collectedByThreshold, eligible.length);
      })(),
      states,
      failureModes: failures,
      statusCodes: rows.reduce<Record<string, number>>((histogram, { observation }) => { if (observation.statusCode != null) histogram[observation.statusCode] = (histogram[observation.statusCode] ?? 0) + 1; return histogram; }, {}),
      ambiguousDispatches: rows.filter(({ observation }) => observation.ambiguous).length,
      providerCostUsd: { sum: costs, mean: knownCosts.length ? costs / knownCosts.length : null, known: knownCosts.length, unknown: rows.length - knownCosts.length },
      priceTableUsd: { expected: expected, ratio: expected && knownCosts.length === rows.length ? costs / expected : null },
      projected30QuestionEngineUsd: knownCosts.length ? costs / knownCosts.length * 30 : null,
      projectedMonthlyDailyEngineUsd: knownCosts.length ? costs / knownCosts.length * 30 * 30 : null,
      balanceDeltaUsd: typeof balanceBefore === "number" && typeof balanceAfter === "number" ? balanceBefore - balanceAfter : null,
      openRouterUsageUsd: optionalSum(rows.map(({ observation }) => observation.openRouterCostUsd)),
      brightDataPriceTableUsd: optionalSum(rows.map(({ observation }) => observation.brightDataPriceUsd)),
      aioCaptureModes: rows.reduce<Record<string, number>>((counts, { observation }) => { if (observation.aioCaptureMode) counts[observation.aioCaptureMode] = (counts[observation.aioCaptureMode] ?? 0) + 1; return counts; }, {}),
      parserSampleSize: parser.length,
    };
  }
  for (const [key, item] of Object.entries(output)) {
    if (item.arm === "current") continue;
    const currentEngine = item.engine === "google_ai_overview" ? "aio" : item.engine;
    const current = output[`current:${currentEngine}`];
    if (!current) { item.crossArmAgreement = null; continue; }
    const paired = rowsFor(observations, item.arm, item.engine, current.arm, currentEngine, answerById);
    const mentionAgreement = paired.filter((pair) => Boolean(pair.left.brandMentioned) === Boolean(pair.right.brandMentioned)).length;
    item.crossArmAgreement = {
      mentioned: safeRate(mentionAgreement, paired.length),
      citationDomainJaccardMean: paired.length ? paired.reduce((sum, pair) => sum + jaccard((pair.left.citations ?? []).map((item: DataRecord) => item.domain), (pair.right.citations ?? []).map((item: DataRecord) => item.domain)), 0) / paired.length : null,
    };
  }
  const armGroups = new Map<string, BakeoffMetric[]>();
  for (const item of Object.values(output)) {
    if (!armGroups.has(item.arm)) armGroups.set(item.arm, []);
    armGroups.get(item.arm)!.push(item);
  }
  for (const armItems of armGroups.values()) {
    const projections = armItems.map((item) => item.projected30QuestionEngineUsd).filter((value) => value !== null);
    const complete = projections.length === armItems.length;
    const total = complete ? projections.reduce((sum, value) => sum + value, 0) : null;
    for (const item of armItems) {
      item.projected30QuestionScanUsd = total;
      item.projectedMonthlyDailyUsd = total === null ? null : total * 30;
      item.projectedEngineCount = armItems.length;
      item.projectedPricedEngineCount = projections.length;
    }
  }
  return output;
}

function optionalSum(values: unknown[]): number | null {
  const known = values.filter((value) => value !== null && value !== undefined && Number.isFinite(Number(value))).map(Number);
  return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
}

function rowsFor(observations: DataRecord[], armA: string, engineA: string, armB: string, engineB: string, answers: Map<string, DataRecord>) {
  const byQuestion = new Map<number, Record<string, DataRecord>>();
  for (const observation of observations.filter((item) => item.arm === armA && item.engine === engineA || item.arm === armB && item.engine === engineB)) {
    const pair: Record<string, DataRecord> = byQuestion.get(observation.questionIndex) ?? {};
    pair[observation.arm] = answers.get(observation.id) ?? {};
    byQuestion.set(observation.questionIndex, pair);
  }
  return [...byQuestion.values()].filter((pair) => pair[armA] && pair[armB]).map((pair) => ({ left: pair[armA], right: pair[armB] }));
}

export function renderSummaryMarkdown(metrics: Record<string, BakeoffMetric>): string {
  const values = Object.values(metrics);
  const lines = ["# DataForSEO bake-off summary", "", "Metrics contain counts and aggregates only; answer text is intentionally excluded.", ""];
  const rate = (item: { total: number; count: number; rate: number | null }) => item.total
    ? `${item.count} of ${item.total} (${((item.rate ?? 0) * 100).toFixed(1)}%)`
    : "0 of 0 (n/a)";
  const number = (value: number | null | undefined, digits = 2) => Number.isFinite(value) ? Number(value).toFixed(digits) : "n/a";
  const cell = (value: unknown) => String(value ?? "n/a").replace(/[|\r\n]/g, " ");
  const histogram = (value: Record<string, number>) => Object.keys(value).length
    ? Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => `${cell(key)}: ${count}`).join(", ")
    : "none";
  const table = (header: string[], rows: unknown[][]) => {
    lines.push(`| ${header.join(" | ")} |`);
    lines.push(`|${header.map(() => "---").join("|")}|`);
    for (const row of rows) lines.push(`| ${row.map(cell).join(" | ")} |`);
    lines.push("");
  };
  const rows = (project: (value: BakeoffMetric) => unknown[]) => values.map((value) => [value.arm, value.engine, ...project(value)]);

  lines.push("## 1. India location support", "", "`.in` citation locality is a heuristic, not location proof.", "");
  table(["Arm", "Engine", "Accepted / posted", "Rejected task_post entries", "Rejected status codes", "Echoed location 2356 / accepted", ".in heuristic / answered"], rows((value) => [
    rate(value.indiaAcceptance), value.rejectedTasks, histogram(value.rejectedStatusCodes), rate(value.echoedIndiaLocation), rate(value.indiaDomainHeuristic),
  ]));

  lines.push("## 2. AI Overview presence and async refunds", "");
  table(["Arm", "Engine", "AIO present / valid SERPs", "Capture modes", "Queued Google refunds (< $0.0012) / accepted queued Google tasks"], rows((value) => [
    rate(value.aiOverviewPresence), histogram(value.aioCaptureModes), rate(value.asyncRefundObserved),
  ]));

  lines.push("## 3. Answer fidelity, extraction, and cross-arm agreement", "");
  table(["Arm", "Engine", "Answered", "Empty answers", "Offcult mentioned", "Branded mention", "Non-branded mention", "Mean competitors", "Citation coverage", "Mean citations", "Median answer chars", "Parser agreement", "Cross-arm Offcult agreement", "Citation-domain Jaccard mean (paired questions)"], rows((value) => [
    rate(value.answered), rate(value.emptyAnswer), rate(value.offcultMention), rate(value.brandedMention), rate(value.nonBrandedMention),
    number(value.meanCompetitorsNamed), rate(value.citationCoverage), number(value.meanCitations), number(value.medianAnswerLength, 0), rate(value.parserAgreement),
    value.crossArmAgreement ? rate(value.crossArmAgreement.mentioned) : "n/a (current baseline)",
    value.crossArmAgreement ? `${number(value.crossArmAgreement.citationDomainJaccardMean, 3)} (${value.crossArmAgreement.mentioned.total} paired questions)` : "n/a (current baseline)",
  ]));

  lines.push("## 4. Latency and queued collection", "");
  table(["Arm", "Engine", "Live request wall p50 / p90 / max (ms)", "Queued post-to-result p50 / p90 / max (min)", "Collected by 10 min / eligible accepted queued tasks", "Collected by 30 min / eligible accepted queued tasks"], rows((value) => [
    `${number(value.latencyMs.p50, 0)} / ${number(value.latencyMs.p90, 0)} / ${number(value.latencyMs.max, 0)}`,
    `${number(value.queuedLatencyMinutes.p50)} / ${number(value.queuedLatencyMinutes.p90)} / ${number(value.queuedLatencyMinutes.max)}`,
    rate(value.collectedBy10Minutes), rate(value.collectedBy30Minutes),
  ]));

  lines.push("## 5. Failure modes", "");
  table(["Arm", "Engine", "Observation states", "provider_failure.kind", "DataForSEO status codes", "Rejected task_post entries", "No-results", "Ambiguous dispatches"], rows((value) => [
    histogram(value.states), histogram(value.failureModes), histogram(value.statusCodes), value.rejectedTasks, value.noResults, value.ambiguousDispatches,
  ]));

  lines.push("## 6. Cost vs price table (USD)", "");
  table(["Arm", "Engine", "Provider cost sum", "Provider cost mean", "Known / unknown costs", "Price-table expected", "Provider / price ratio", "OpenRouter usage.cost", "Bright Data price-table cost", "Projected 30 questions (engine)", "Projected daily ×30 (engine)"], rows((value) => [
    number(value.providerCostUsd.sum, 4), number(value.providerCostUsd.mean, 4), `${value.providerCostUsd.known} / ${value.providerCostUsd.unknown}`,
    number(value.priceTableUsd.expected, 4), number(value.priceTableUsd.ratio, 3), number(value.openRouterUsageUsd, 4),
    number(value.brightDataPriceTableUsd, 4), number(value.projected30QuestionEngineUsd, 4), number(value.projectedMonthlyDailyEngineUsd, 4),
  ]));
  lines.push("### Per-arm projection for the configured engine set", "");
  const armProjectionRows = [...armGroupsFromMetrics(values).entries()].map(([arm, armValues]) => {
    const projection = armValues[0];
    const complete = projection.projectedPricedEngineCount === projection.projectedEngineCount;
    return [
      arm,
      projection.projectedEngineCount,
      `${projection.projectedPricedEngineCount} of ${projection.projectedEngineCount}`,
      complete ? number(projection.projected30QuestionScanUsd, 4) : "unknown (incomplete engine costs)",
      complete ? number(projection.projectedMonthlyDailyUsd, 4) : "unknown (incomplete engine costs)",
    ];
  });
  table(["Arm", "Configured engines", "Priced engine projections", "30-question arm scan (USD)", "Daily schedule ×30 (USD)"], armProjectionRows);
  const dataForSeoCost = values.filter((value) => String(value.arm).startsWith("dfs_")).reduce((sum, value) => sum + Number(value.providerCostUsd.sum || 0), 0);
  const balanceDelta = values.find((value) => value.balanceDeltaUsd !== null && value.balanceDeltaUsd !== undefined)?.balanceDeltaUsd;
  lines.push(`DataForSEO balance delta (before − after): $${number(balanceDelta, 4)}; summed DataForSEO task costs: $${number(dataForSeoCost, 4)}.`);
  return lines.join("\n") + "\n";
}

function armGroupsFromMetrics(values: BakeoffMetric[]): Map<string, BakeoffMetric[]> {
  const groups = new Map<string, BakeoffMetric[]>();
  for (const value of values) {
    if (!groups.has(value.arm)) groups.set(value.arm, []);
    groups.get(value.arm)!.push(value);
  }
  return groups;
}
