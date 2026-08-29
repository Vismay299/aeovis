#!/usr/bin/env node
/**
 * check:secrets — the smallest possible LIVE call per vendor (R0.1.6, S20).
 *
 * /api/health reports whether a credential is CONFIGURED. This reports whether
 * it WORKS, which is a different and more useful question: the failure this
 * closes is a deployment where every env var is set, every health check is
 * green, and the key is revoked — a scan then produces a plausible-looking
 * result built on nothing.
 *
 * Rules this script follows, because it exists to tell the truth about state:
 *   - Exactly three verdicts. UNCONFIGURED (no credential) is NOT a pass and
 *     NOT a failure; it is a third thing, and it must look different from both.
 *   - Exit code is non-zero only when a CONFIGURED vendor fails. An
 *     unconfigured optional vendor must not break a deploy gate.
 *   - Every call is the cheapest read the vendor offers, with a hard timeout.
 *     Nothing here creates, writes, or spends more than a token or two.
 *
 * Usage:
 *   npm run check:secrets              # reads .env.local
 *   node scripts/check-secrets.mjs     # reads the ambient environment
 */

const PASS = "PASS";
const FAIL = "FAIL";
const UNCONFIGURED = "UNCONFIGURED";

const TIMEOUT_MS = Number(process.env.CHECK_SECRETS_TIMEOUT_MS || 20000);

const env = (name) => String(process.env[name] || "").trim();

/** fetch with a hard deadline — a hung vendor must not hang the check. */
async function get(url, init = {}) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

/** Turn an HTTP response into a verdict, naming the status on failure. */
async function fromResponse(res, okDetail) {
  if (res.ok) return { verdict: PASS, detail: okDetail };
  const body = await res.text().catch(() => "");
  return { verdict: FAIL, detail: `HTTP ${res.status}${body ? ` — ${body.slice(0, 120)}` : ""}` };
}

/**
 * One entry per vendor. `keys` are the env vars it needs; when any is missing
 * the vendor is UNCONFIGURED and `check` is never called.
 */
const VENDORS = [
  {
    name: "supabase",
    required: true,
    keys: ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"],
    // PostgREST select-1: no rows returned, cheapest possible round trip.
    async check() {
      const res = await get(`${env("NEXT_PUBLIC_SUPABASE_URL")}/rest/v1/scans?select=id&limit=1`, {
        headers: {
          apikey: env("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
          Authorization: `Bearer ${env("NEXT_PUBLIC_SUPABASE_ANON_KEY")}`,
        },
      });
      return fromResponse(res, "select 1 from scans");
    },
  },
  {
    name: "brightdata",
    required: true,
    keys: ["BRIGHTDATA_API_KEY"],
    // Mirrors src/lib/engines/brightdata.js's own zone lookup, and also tells
    // the operator whether an ACTIVE serp zone exists — a valid key with no
    // active serp zone fails every scan and is otherwise invisible here.
    async check() {
      const res = await get("https://api.brightdata.com/zone/get_all_zones", {
        headers: { Authorization: `Bearer ${env("BRIGHTDATA_API_KEY")}` },
      });
      if (!res.ok) return fromResponse(res);
      const zones = await res.json().catch(() => []);
      const serp = (zones || []).filter((z) => z.type === "serp" && z.status === "active");
      if (!serp.length) {
        return { verdict: FAIL, detail: "key works, but no ACTIVE serp zone — every AIO probe will fail" };
      }
      return { verdict: PASS, detail: `${serp.length} active serp zone(s)` };
    },
  },
  {
    name: "llm",
    required: true,
    keys: ["OPENROUTER_API_KEY"],
    // One token against the configured model. Also proves the MODEL is valid
    // on this gateway, which a key check alone does not: a model id valid on
    // one OpenAI-compatible gateway is routinely invalid on another.
    async check() {
      const base = (env("OPENROUTER_BASE_URL") || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
      const model = env("OPENROUTER_MODEL") || "google/gemma-4-31b-it:free";
      const res = await get(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env("OPENROUTER_API_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
      });
      return fromResponse(res, `model ${model} answered`);
    },
  },
  {
    name: "perplexity",
    required: false,
    keys: ["PERPLEXITY_API_KEY"],
    async check() {
      const res = await get("https://api.perplexity.ai/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env("PERPLEXITY_API_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: env("PERPLEXITY_MODEL") || "sonar",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 1,
        }),
      });
      return fromResponse(res, "1-token completion");
    },
  },
  {
    name: "firecrawl",
    required: false,
    keys: ["FIRECRAWL_API_KEY"],
    async check() {
      const res = await get("https://api.firecrawl.dev/v1/scrape", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env("FIRECRAWL_API_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: "https://example.com", formats: ["markdown"], onlyMainContent: true }),
      });
      return fromResponse(res, "scraped example.com");
    },
  },
  {
    name: "openai",
    required: false,
    keys: ["OPENAI_API_KEY"],
    async check() {
      const res = await get("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${env("OPENAI_API_KEY")}` },
      });
      return fromResponse(res, "model list");
    },
  },
  {
    name: "gemini",
    required: false,
    keys: ["GEMINI_API_KEY"],
    async check() {
      const res = await get(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(env("GEMINI_API_KEY"))}`
      );
      return fromResponse(res, "model list");
    },
  },
  {
    name: "gsc",
    required: false,
    keys: ["GSC_SERVICE_ACCOUNT_KEY"],
    // No live call: the credential is a service-account JSON, and exchanging
    // it for a token needs a JWT signature that would pull in a dependency
    // this script deliberately does not have. Validate what CAN be validated
    // offline and SAY that is what happened — reporting "PASS" for a check
    // that never ran is the exact lie this whole script exists to prevent.
    async check() {
      const raw = env("GSC_SERVICE_ACCOUNT_KEY");
      let json;
      try {
        json = JSON.parse(/^\s*\{/.test(raw) ? raw : Buffer.from(raw, "base64").toString("utf8"));
      } catch {
        return { verdict: FAIL, detail: "not valid JSON, and not valid base64-encoded JSON" };
      }
      const missing = ["client_email", "private_key", "type"].filter((k) => !json[k]);
      if (missing.length) return { verdict: FAIL, detail: `service account is missing ${missing.join(", ")}` };
      return {
        verdict: PASS,
        detail: `shape valid for ${json.client_email} — NOT verified against the API (offline check only)`,
      };
    },
  },
  {
    name: "cron",
    required: true,
    keys: ["CRON_SECRET"],
    // Nothing to call: this secret guards our own routes. Its presence IS the
    // check, and its absence is what makes both worker routes fail closed in
    // production (src/lib/cronAuth.js).
    async check() {
      const secret = env("CRON_SECRET");
      if (secret.length < 16) {
        return { verdict: FAIL, detail: `only ${secret.length} chars — use a long random string` };
      }
      return { verdict: PASS, detail: "set (local check only — no call to make)" };
    },
  },
];

const MARK = { [PASS]: "  ok  ", [FAIL]: " FAIL ", [UNCONFIGURED]: " ---- " };

async function main() {
  const results = [];

  for (const vendor of VENDORS) {
    const missing = vendor.keys.filter((k) => !env(k));
    if (missing.length) {
      results.push({
        name: vendor.name,
        verdict: UNCONFIGURED,
        detail: `missing ${missing.join(", ")}`,
        required: vendor.required,
      });
      continue;
    }
    let outcome;
    try {
      outcome = await vendor.check();
    } catch (err) {
      // A thrown error is a FAIL, never a skip. An unreachable vendor is not
      // a working one.
      outcome = { verdict: FAIL, detail: err.name === "TimeoutError" ? `timed out after ${TIMEOUT_MS}ms` : err.message };
    }
    results.push({ name: vendor.name, ...outcome, required: vendor.required });
  }

  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    const req = r.required ? "required" : "optional";
    console.log(`[${MARK[r.verdict]}] ${r.name.padEnd(width)}  ${r.verdict.padEnd(12)} ${req.padEnd(8)}  ${r.detail || ""}`);
  }

  const failures = results.filter((r) => r.verdict === FAIL);
  const unconfiguredRequired = results.filter((r) => r.verdict === UNCONFIGURED && r.required);

  console.log("");
  console.log(
    `${results.filter((r) => r.verdict === PASS).length} pass · ${failures.length} fail · ` +
      `${results.filter((r) => r.verdict === UNCONFIGURED).length} unconfigured ` +
      `(${unconfiguredRequired.length} of them required)`
  );
  if (unconfiguredRequired.length) {
    console.log(
      `note: ${unconfiguredRequired.map((r) => r.name).join(", ")} ${
        unconfiguredRequired.length === 1 ? "is" : "are"
      } required for a scan to run. Unconfigured is not a failure here — it is ` +
        `a deployment that cannot scan.`
    );
  }

  // The contract: non-zero ONLY when a CONFIGURED vendor failed.
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`check:secrets crashed: ${err.stack || err}`);
  process.exit(2);
});
