#!/usr/bin/env node
/**
 * F25 owner-only test send (never run by CI, tests or an agent).
 *
 * Writes exactly one `email_outbox` row for an existing confirmed user and
 * prints only that row's id. It never calls Loops: the next `email.deliver`
 * tick sends the row with the same checks and idempotency key as every other
 * transactional email.
 *
 * Refuses unless `--to`, `--template` and `--confirm` are all passed. A
 * non-loopback Supabase/Postgres target additionally requires `--confirm`
 * (already mandatory), so the script is never a silent production write.
 *
 * Usage:
 *   node scripts/qa/send-f25-test-email.mjs \
 *     --to <address> --template scan_finished|schedule_skipped|spend_cap_reached --confirm
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateTemplateData, buildScanFinishedData, buildScheduleSkippedData, buildSpendCapData } from "../../src/lib/email/templates.ts";
import { readEmailConfig } from "../../src/lib/email/config.ts";

export const TEMPLATES = ["scan_finished", "schedule_skipped", "spend_cap_reached"];

export const MISSING_FLAGS_MESSAGE = "Refusing: pass --to, --template and --confirm";
const INVALID_TEMPLATE_MESSAGE = `Refusing: --template must be one of ${TEMPLATES.join(", ")}`;
const INVALID_ADDRESS_MESSAGE = "Refusing: --to must be a single email address";
const UNKNOWN_ARGUMENT_MESSAGE = "Refusing: unknown argument";
const SUPABASE_CONFIG_MESSAGE = "Refusing: Supabase admin configuration is required";
const NO_RECIPIENT_MESSAGE = "Refusing: no confirmed user matches --to";
const INSERT_FAILED_MESSAGE = "Refusing: the outbox row was not written";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURES = path.join(ROOT, "tests/fixtures/f25");

/** A refusal the CLI prints as-is; never carries an address, key or provider body. */
export class RefusalError extends Error {}

function refuse(message) {
  throw new RefusalError(message);
}

/**
 * Parse the CLI flags. Unknown arguments and missing values refuse; no value is
 * ever echoed back.
 */
export function parseArgs(argv) {
  const args = { to: null, template: null, confirm: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--confirm") {
      args.confirm = true;
    } else if (arg === "--to") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) refuse(MISSING_FLAGS_MESSAGE);
      args.to = value;
      i += 1;
    } else if (arg === "--template") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) refuse(MISSING_FLAGS_MESSAGE);
      args.template = value;
      i += 1;
    } else {
      refuse(UNKNOWN_ARGUMENT_MESSAGE);
    }
  }

  if (!args.to || !args.template || !args.confirm) refuse(MISSING_FLAGS_MESSAGE);
  if (!TEMPLATES.includes(args.template)) refuse(INVALID_TEMPLATE_MESSAGE);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args.to) || args.to.length > 254) {
    refuse(INVALID_ADDRESS_MESSAGE);
  }

  return { to: args.to, template: args.template, confirm: args.confirm };
}

export function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

/** Hosts the run would write to, from the environment only (names, never values). */
export function targetHosts(env = process.env) {
  const hosts = [];
  if (env.PGHOST) hosts.push(env.PGHOST);
  for (const name of ["DATABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL"]) {
    const raw = env[name];
    if (!raw) continue;
    try {
      hosts.push(new URL(raw).hostname);
    } catch {
      hosts.push("invalid");
    }
  }
  return hosts;
}

/**
 * Owner note: refuse unless the target is loopback or `--confirm` was passed.
 * `--confirm` is mandatory in parseArgs, so this is the belt-and-braces check
 * for callers that reach the guard directly.
 */
export function assertTargetAllowed(hosts, { confirm }) {
  const nonLoopback = hosts.filter((host) => !isLoopbackHost(host));
  if (nonLoopback.length > 0 && !confirm) refuse(MISSING_FLAGS_MESSAGE);
  return { nonLoopback: nonLoopback.length > 0 };
}

export function assertSupabaseConfigured(env = process.env) {
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    refuse(SUPABASE_CONFIG_MESSAGE);
  }
}

const CONFIRMED_USER_MAX_PAGES = 100;
const CONFIRMED_USER_PER_PAGE = 200;

/**
 * Resolve `--to` to an existing confirmed auth user. The address is only
 * compared, never printed.
 */
export async function resolveRecipient(admin, email) {
  const wanted = email.toLowerCase();
  for (let page = 1; page <= CONFIRMED_USER_MAX_PAGES; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: CONFIRMED_USER_PER_PAGE,
    });
    if (error) refuse(NO_RECIPIENT_MESSAGE);
    const users = data?.users ?? [];
    const match = users.find((user) => user.email?.toLowerCase() === wanted);
    if (match) {
      if (!match.email_confirmed_at) refuse(NO_RECIPIENT_MESSAGE);
      return { id: match.id };
    }
    if (users.length < CONFIRMED_USER_PER_PAGE) break;
  }
  refuse(NO_RECIPIENT_MESSAGE);
}

function readFixture(name) {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));
}

const FIXTURE_NOW = new Date("2026-10-22T14:30:00Z");

/** Template variables from the recorded fixtures; no answer text ever reaches `data`. */
export function buildFixtureData(template, { appUrl, now = FIXTURE_NOW } = {}) {
  const brand = { brand_key: "acme-corp", display_name: "ACME" };
  const links = { appUrl: appUrl ?? "https://perceev.com" };

  if (template === "scan_finished") {
    const scan = readFixture("scan-row.json");
    return buildScanFinishedData(scan, brand, links);
  }
  if (template === "schedule_skipped") {
    const windows = readFixture("window-rows.json");
    const window = windows.find((row) => row.reason === "price_changed") ?? windows[0];
    const nextRunAt = new Date(new Date(window.recorded_at).getTime() + 7 * 24 * 60 * 60 * 1000);
    return buildScheduleSkippedData(window, brand, nextRunAt, links);
  }
  if (template === "spend_cap_reached") {
    return buildSpendCapData(
      { reason: "daily_cap", limitUsd: 5, now, usagePageEnabled: false },
      brand,
      links,
    );
  }
  refuse(INVALID_TEMPLATE_MESSAGE);
}

/**
 * The whole run, injectable for tests. Every refusal happens before the
 * service-role client is used, so a bad invocation writes nothing.
 */
export async function runTestSend({ argv, env = process.env, deps = {} }) {
  const args = parseArgs(argv);
  assertTargetAllowed(targetHosts(env), { confirm: args.confirm });
  assertSupabaseConfigured(env);

  const cfg = readEmailConfig(env);
  const admin = deps.admin ?? (await import("../../src/lib/supabase/admin.js")).getSupabaseAdmin(env);
  if (!admin) refuse(SUPABASE_CONFIG_MESSAGE);

  const recipient = await resolveRecipient(admin, args.to);
  const data = buildFixtureData(args.template, {
    appUrl: cfg.appUrl,
    now: deps.now ?? FIXTURE_NOW,
  });
  validateTemplateData(args.template, data);

  const dedupeKey = `manual-test:${args.template}:${(deps.uuid ?? randomUUID)()}`;
  const { data: inserted, error } = await admin
    .from("email_outbox")
    .insert({
      kind: "transactional",
      template: args.template,
      user_id: recipient.id,
      brand_key: null,
      dedupe_key: dedupeKey,
      data,
      status: "pending",
    })
    .select("id")
    .single();

  if (error || !inserted?.id) refuse(INSERT_FAILED_MESSAGE);
  return { id: inserted.id };
}

async function main() {
  try {
    const { id } = await runTestSend({ argv: process.argv.slice(2) });
    console.log(id);
  } catch (err) {
    console.error(err instanceof RefusalError ? err.message : "Refusing: test send failed");
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  await main();
}
