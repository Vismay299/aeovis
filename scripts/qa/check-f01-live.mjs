#!/usr/bin/env node
/**
 * F01 LLM helper live check (owner-run only, never in CI).
 *
 * One `llmText` call with the prompt "Reply with the single word: ok",
 * `maxOutputTokens: 5` and `maxUsd: 0.01`, through the metered spend guard on
 * the `platform.selftest` feature. Prints only the ledger row's cost_source
 * and accounted_usd — never the prompt or the answer.
 *
 * Usage:
 *   node scripts/qa/check-f01-live.mjs --max-spend-usd 0.01 --brand <brand-key>
 */

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] ?? null;
};

const maxSpend = flag("--max-spend-usd");
const brand = flag("--brand");

if (maxSpend !== "0.01" || !brand) {
  console.error("refusing: --max-spend-usd 0.01 and --brand are required");
  process.exit(2);
}

const [{ llmText }] = [await import("../../src/lib/llm/index.ts")];
const idempotencyKey = `live:selftest:${Date.now()}`;

const { text } = await llmText(
  {
    brandKey: brand,
    feature: "platform.selftest",
    system: "You answer with one word.",
    prompt: "Reply with the single word: ok",
    maxUsd: 0.01,
    idempotencyKey,
    maxOutputTokens: 5,
  }
);

// Only the cost columns leave this script: the prompt and answer stay out of logs.
const { getSupabaseAdmin } = await import("../../src/lib/supabase/admin.js");
const admin = getSupabaseAdmin();
const { data, error } = await admin
  .from("spend_ledger")
  .select("cost_source,accounted_usd")
  .eq("brand_key", brand)
  .order("occurred_at", { ascending: false })
  .limit(1)
  .maybeSingle();
if (error) throw error;
console.log(JSON.stringify({ cost_source: data?.cost_source ?? null, accounted_usd: data?.accounted_usd ?? null }));
void text;
