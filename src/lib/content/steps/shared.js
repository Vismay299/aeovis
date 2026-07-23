import { contentLlmJson } from "../../llm.js";
import { getFormat } from "../agents/formats.js";

/**
 * Shared helpers for pipeline steps. Each step module exposes a
 * `run<Step>(ctx, deps)` where deps carries injectable effects
 * ({ llm, scrape }) so tests run fixture-based with zero live calls.
 */

/**
 * One LLM call with schema validation and a single correction retry.
 * Invalid twice → throws with the step named (the worker fails the job
 * with that message, per the plan's step contract).
 */
export async function callStepLlm({ step, prompt, validate, llm, stats, temperature = 0.3 }) {
  const call = llm || contentLlmJson;

  let out = await call(prompt, { stats, temperature });
  let result = validate(out);
  if (result.ok) return result.value;

  const retryPrompt =
    prompt +
    "\n\n---\nYour previous output was INVALID for these reasons:\n- " +
    result.errors.join("\n- ") +
    "\nReturn the corrected JSON only.";
  out = await call(retryPrompt, { stats, temperature: Math.min(1, temperature + 0.1) });
  result = validate(out);
  if (result.ok) return result.value;

  const err = new Error(
    `Step "${step}" produced invalid output after retry: ${result.errors.join("; ")}`
  );
  err.step = step;
  throw err;
}

/**
 * Agent overlay — the block injected into EVERY step so the pipeline produces
 * exactly the format, channel, and design the user configured. This is what
 * makes an agent "a Listicle Writer" vs "a GEO article writer" without any
 * code change: the format's structure directive + the agent's own rules.
 */
export function formatAgentOverlay(agent) {
  if (!agent) return "(no custom agent — use the base playbook defaults)";
  const fmt = getFormat(agent.format);
  const lines = [];
  lines.push(`AGENT: "${agent.name}" ${agent.emoji || ""}`.trim());
  if (agent.description) lines.push(`Purpose: ${agent.description}`);
  lines.push(`OUTPUT FORMAT — ${fmt.label} (this is BINDING, it overrides the base structure):`);
  lines.push(fmt.structure);
  if (agent.length_hint) lines.push(`Target length: ${agent.length_hint}.`);
  if (agent.channel) lines.push(`Channel: ${agent.channel} (write for how content is consumed there).`);

  // Format-specific config (e.g. listicle item count, thread post count).
  const cfg = agent.format_config || {};
  const cfgPairs = Object.entries(cfg).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (cfgPairs.length) {
    lines.push(
      "Format settings: " + cfgPairs.map(([k, v]) => `${k}=${v}`).join(", ") + " (obey these exactly)."
    );
  }

  if ((agent.design_rules || []).length) {
    lines.push("Design rules (in addition to the brand brief's tone rules):");
    for (const r of agent.design_rules) lines.push(`- ${r}`);
  }
  if (agent.custom_instructions) {
    lines.push("Custom instructions from the operator (obey these over defaults on conflict):");
    lines.push(agent.custom_instructions);
  }
  return lines.join("\n");
}

/** Lessons list → the injected prompt block. Explicit "none" beats silence. */
export function formatLessons(lessons) {
  const list = (lessons || []).map((l) => (typeof l === "string" ? l : l.lesson)).filter(Boolean);
  if (list.length === 0) return "(none yet — this brand+playbook has no stored lessons)";
  return list.map((l) => `- ${l}`).join("\n");
}

/**
 * Normalize scan raw_results rows to one shape regardless of engine era
 * (v8 rows carry aio_text/aio_references, v9 multi-engine rows carry
 * text/references).
 */
export function normalizeScanRows(scan) {
  const rows = scan?.raw_results?.results || scan?.results || [];
  return rows.map((r) => ({
    prompt: r.prompt || r.text_query || "",
    engine: r.engine || "aio",
    present: !!(r.answer_present || r.aio_present),
    text: r.text || r.aio_text || "",
    references: (r.references || r.aio_references || []).map((ref) => ({
      href: ref.href || "",
      title: ref.title || "",
      source: ref.source || "",
      domain: ref.domain || "",
    })),
    visible: !!r.visible,
    brand_cited: !!(r.brand_cited ?? r.brandCited),
    is_branded_query: !!(r.is_branded_query ?? r.isBrandedQuery),
    topic: r.topic || "General",
  }));
}

function queryKey(text) {
  return String(text || "").toLowerCase().trim();
}

/** Scan rows (all engines) matching any of the given query texts. */
export function rowsForQueries(scan, queries) {
  const keys = new Set((queries || []).map(queryKey).filter(Boolean));
  if (keys.size === 0) return [];
  return normalizeScanRows(scan).filter((r) => keys.has(queryKey(r.prompt)));
}

/** Compact per-engine answer block for prompts (bounded to keep tokens sane). */
export function formatScanAnswers(rows, { maxRows = 9, maxChars = 1400 } = {}) {
  if (!rows || rows.length === 0) return "(no scan rows available for these queries)";
  return rows
    .slice(0, maxRows)
    .map((r) => {
      const refs = r.references
        .slice(0, 8)
        .map((ref) => `  - ${ref.href}${ref.title ? ` (${ref.title})` : ""}`)
        .join("\n");
      return [
        `### [${r.engine}] "${r.prompt}"`,
        r.present ? (r.text || "").slice(0, maxChars) : "(engine gave no answer)",
        refs ? `Citations:\n${refs}` : "Citations: (none)",
      ].join("\n");
    })
    .join("\n\n");
}

/** Citations grouped per engine, for the benchmark teardown prompt. */
export function formatCitationsByEngine(rows) {
  if (!rows || rows.length === 0) return "(no citations available)";
  const byEngine = new Map();
  for (const r of rows) {
    if (!byEngine.has(r.engine)) byEngine.set(r.engine, []);
    for (const ref of r.references) {
      byEngine.get(r.engine).push(`${ref.href}${ref.title ? ` — ${ref.title}` : ""}`);
    }
  }
  return Array.from(byEngine.entries())
    .map(([engine, refs]) => {
      const unique = Array.from(new Set(refs)).slice(0, 20);
      return `### ${engine}\n${unique.length ? unique.map((u) => `- ${u}`).join("\n") : "- (none)"}`;
    })
    .join("\n\n");
}

/**
 * Top cited URLs across rows by citation frequency (one per domain),
 * excluding obvious non-content hosts. These are the "winning pages" the
 * research step scrapes.
 */
export function topCitedUrls(rows, max = 3) {
  const counts = new Map(); // domain -> { url, count }
  for (const r of rows || []) {
    for (const ref of r.references) {
      if (!ref.href || !/^https?:\/\//i.test(ref.href)) continue;
      let domain;
      try {
        domain = new URL(ref.href).hostname.replace(/^www\./, "");
      } catch {
        continue;
      }
      if (/google\.|youtube\.|facebook\.|instagram\./i.test(domain)) continue;
      const entry = counts.get(domain);
      if (entry) entry.count += 1;
      else counts.set(domain, { url: ref.href, count: 1 });
    }
  }
  return Array.from(counts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, max)
    .map((e) => e.url);
}

/** Scraped pages → bounded markdown block for prompts. */
export function formatScrapedPages(scraped) {
  if (!scraped || scraped.length === 0) return "(no pages scraped)";
  return scraped
    .map((p) => `## ${p.url}\n${(p.content || "").slice(0, 3500)}`)
    .join("\n\n---\n\n");
}
