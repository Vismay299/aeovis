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

import { LLM_ENV, getLlmApiKey, getLlmBaseUrl, getLlmModel, getLlmProvider } from "../src/lib/llmConfig.js";

const PASS = "PASS";
const FAIL = "FAIL";
const UNCONFIGURED = "UNCONFIGURED";

const TIMEOUT_MS = Number(process.env.CHECK_SECRETS_TIMEOUT_MS || 20000);

const env = (name) => String(process.env[name] || "").trim();

/** fetch with a hard deadline — a hung vendor must not hang the check. */
async function get(url, init = {}) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

/**
 * Turn an HTTP response into a verdict, naming the status on failure.
 *
 * `failContext` names WHO answered, and only the failure path needs it: a PASS
 * detail already says. It exists because a 402 reading "Insufficient account
 * balance" from a gateway configured as MiMo was read for a week as an
 * OpenRouter billing problem, and the fix attempted was rotating an OpenRouter
 * key that nothing calls. The host is the one fact that disambiguates it.
 */
async function fromResponse(res, okDetail, failContext = "") {
  if (res.ok) return { verdict: PASS, detail: okDetail };
  const body = await res.text().catch(() => "");
  const who = failContext ? ` from ${failContext}` : "";
  return { verdict: FAIL, detail: `HTTP ${res.status}${who}${body ? ` — ${body.slice(0, 120)}` : ""}` };
}

/**
 * One entry per vendor. `keys` are the env vars it needs; when any is missing
 * the vendor is UNCONFIGURED and `check` is never called. `anyKeys` is the
 * either/or form for a credential with a deprecated alias: at least one must
 * be set, and the FIRST (canonical) one is what an operator is told to set.
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
    // R0.1.10 (finding C4) — validate the credential the CLIENT will use.
    //
    // This used to call get_all_zones and pass if ANY active serp zone existed,
    // never reading BRIGHTDATA_SERP_ZONE. But brightdata.js:10 short-circuits on
    // that variable: when it is set, that zone is the one every probe uses. So a
    // typo'd zone reported PASS here — an account with a healthy zone list and
    // not a single working probe — and the failure then arrived per-query, as a
    // cost-0.0 error row on all thirty. The check said the credential was good
    // and the scan quietly measured nothing.
    //
    // Now: resolve the zone the same way the client does, then assert THAT zone
    // is present and active.
    async check() {
      const res = await get("https://api.brightdata.com/zone/get_all_zones", {
        headers: { Authorization: `Bearer ${env("BRIGHTDATA_API_KEY")}` },
      });
      if (!res.ok) return fromResponse(res, undefined, "api.brightdata.com");

      const zones = await res.json().catch(() => []);
      const serp = (zones || []).filter((z) => z.type === "serp" && z.status === "active");
      const configured = (process.env.BRIGHTDATA_SERP_ZONE || "").trim();

      if (configured) {
        const match = (zones || []).find((z) => z.name === configured);
        if (!match) {
          return {
            verdict: FAIL,
            detail:
              `BRIGHTDATA_SERP_ZONE="${configured}" does not exist on this account. ` +
              `Every AIO probe will fail. Active serp zones: ${
                serp.map((z) => z.name).join(", ") || "(none)"
              }`,
          };
        }
        if (match.status !== "active" || match.type !== "serp") {
          return {
            verdict: FAIL,
            detail:
              `BRIGHTDATA_SERP_ZONE="${configured}" exists but is type=${match.type} ` +
              `status=${match.status}, not an active serp zone. Every AIO probe will fail.`,
          };
        }
        return { verdict: PASS, detail: `configured zone "${configured}" is an active serp zone` };
      }

      // Unset: the client falls back to the first active serp zone, so that is
      // what gets validated — and the operator is told which one it resolved to,
      // because "it picked one for you" is a fact worth seeing.
      if (!serp.length) {
        return { verdict: FAIL, detail: "key works, but no ACTIVE serp zone — every AIO probe will fail" };
      }
      return {
        verdict: PASS,
        detail: `${serp.length} active serp zone(s); no BRIGHTDATA_SERP_ZONE set, so probes will use "${serp[0].name}"`,
      };
    },
  },
  {
    name: "llm",
    required: true,
    // LLM_API_KEY is canonical; OPENROUTER_API_KEY still configures the vendor
    // as a deprecated alias (R5.1.1). Either one makes this CONFIGURED, and
    // the report names the canonical one when neither is set.
    keys: [],
    anyKeys: [LLM_ENV.apiKey.canonical, LLM_ENV.apiKey.legacy],
    // One token against the configured model. Also proves the MODEL is valid
    // on this gateway, which a key check alone does not: a model id valid on
    // one OpenAI-compatible gateway is routinely invalid on another.
    async check() {
      const base = getLlmBaseUrl(process.env);
      const model = getLlmModel(process.env);
      const provider = getLlmProvider(base);
      // Mirror the client's per-gateway request shape (src/lib/openrouter.js):
      // MiMo reads max_completion_tokens rather than max_tokens, so probing it
      // with the portable spelling can report FAIL on a working deployment.
      const cap = provider === "mimo" ? { max_completion_tokens: 1 } : { max_tokens: 1 };
      const res = await get(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${getLlmApiKey(process.env)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], ...cap }),
      });
      return fromResponse(
        res,
        `model ${model} answered on ${provider} (${base})`,
        `${provider} (${base})`
      );
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
          // Perplexity rejects max_tokens below 16 with a 400 before it ever
          // looks at the key, so a 1-token probe reported FAIL for a working
          // credential — the misleading-script failure this check exists to prevent.
          max_tokens: 16,
        }),
      });
      return fromResponse(res, "16-token completion");
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
    // Either/or credentials: none of the accepted names set means the vendor is
    // UNCONFIGURED, reported under its canonical name.
    if (vendor.anyKeys?.length && !vendor.anyKeys.some((k) => env(k))) missing.push(vendor.anyKeys[0]);
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
