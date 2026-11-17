#!/usr/bin/env node
import { createClient } from "@supabase/supabase-js";
import {
  expectedWindows,
  unexplainedGaps,
} from "../../src/server/schedules/soakLedger.ts";

const USAGE = [
  "usage: node scripts/qa/f10-window-ledger.mjs --brand <brand-key> --from <ISO-date-or-timestamp> --to <ISO-date-or-timestamp>",
  "       node scripts/qa/f10-window-ledger.mjs --help",
  "Reads the customer schedule and measurement_windows ledger with the Supabase service role.",
  "Required environment variable names: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.",
].join("\n");

function parseArgs(argv) {
  const values = new Map();
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (!["--brand", "--from", "--to"].includes(token)) {
      throw new Error("Unknown argument.\n" + USAGE);
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${token} needs a value.\n${USAGE}`);
    }
    values.set(token, value);
    i += 1;
  }
  return { help, values };
}

function parseDateBound(value, endOfDate = false) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    const start = new Date(Date.UTC(year, month - 1, day));
    if (
      start.getUTCFullYear() !== year ||
      start.getUTCMonth() !== month - 1 ||
      start.getUTCDate() !== day
    ) {
      throw new Error("Date input is invalid.");
    }
    if (endOfDate) start.setUTCHours(23, 59, 59, 999);
    return start.toISOString();
  }
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error("Timestamp input must include a timezone.");
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Date input is invalid.");
  return date.toISOString();
}

function isoForWindow(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Ledger has an invalid window timestamp.");
  return date.toISOString();
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    fail(error.message);
    return;
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const brand = args.values.get("--brand");
  const rawFrom = args.values.get("--from");
  const rawTo = args.values.get("--to");
  if (!brand || brand.length > 200 || /[\r\n]/.test(brand) || !rawFrom || !rawTo) {
    fail("Provide a valid --brand, --from, and --to.\n" + USAGE);
    return;
  }

  let from;
  let to;
  try {
    from = parseDateBound(rawFrom);
    to = parseDateBound(rawTo, /^\d{4}-\d{2}-\d{2}$/.test(rawTo));
  } catch (error) {
    fail(error.message);
    return;
  }
  if (Date.parse(to) < Date.parse(from)) {
    fail("The --to date must be on or after --from.");
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    fail("Set SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY.");
    return;
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: schedule, error: scheduleError } = await supabase
    .from("scan_schedules")
    .select("brand,schedule_interval,next_run_at")
    .eq("brand", brand)
    .eq("managed_by", "customer")
    .maybeSingle();
  if (scheduleError) {
    fail("Could not read the customer schedule.");
    return;
  }
  if (
    !["daily", "weekly", "monthly"].includes(schedule?.schedule_interval) ||
    !schedule?.next_run_at
  ) {
    fail("No customer schedule with an interval and next run was found.");
    return;
  }

  const { data: recordedRows, error: ledgerError } = await supabase
    .from("measurement_windows")
    .select("window_at,disposition,reason")
    .eq("brand", brand)
    .gte("window_at", from)
    .lte("window_at", to)
    .order("window_at", { ascending: true })
    .limit(10_000);
  if (ledgerError) {
    fail("Could not read the measurement window ledger.");
    return;
  }

  let expected;
  let recorded;
  try {
    expected = expectedWindows({
      interval: schedule.schedule_interval,
      anchor: isoForWindow(schedule.next_run_at),
      from,
      to,
    });
    recorded = (recordedRows ?? []).map((row) => ({
      ...row,
      window_at: isoForWindow(row.window_at),
    }));
  } catch {
    fail("Schedule or ledger data could not be parsed.");
    return;
  }

  const gaps = unexplainedGaps(expected, recorded);
  const rowsByTime = new Map(recorded.map((row) => [row.window_at, row]));
  const expectedSet = new Set(expected);
  const allWindows = [...new Set([...expected, ...recorded.map((row) => row.window_at)])]
    .sort((a, b) => Date.parse(a) - Date.parse(b));

  for (const windowAt of allWindows) {
    const row = rowsByTime.get(windowAt);
    if (row) {
      console.log(`${windowAt} ${row.disposition} ${row.reason ?? "-"}`);
    } else if (expectedSet.has(windowAt)) {
      console.log(`${windowAt} missing unexplained_gap`);
    }
  }
  console.log(`gaps=${gaps.length}`);
}

await main();
