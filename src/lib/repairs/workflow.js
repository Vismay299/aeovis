import { resolveMeasurementContext } from "../engines/serpGeo.js";
import { createHash } from "node:crypto";
import { redactSecrets } from "../provenance.js";

export const WORKFLOW_VERSION = "repair-workflow-v1";
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export const contentHash = (title, body) =>
  createHash("sha256")
    .update(`${title || ""}\n\n${body || ""}`)
    .digest("hex");
export const artifactHash = (value) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
export function meaningfulText(input = "") {
  return String(input)
    .replace(/<!--[\s\S]*?-->/g," ")
    .replace(/<(?:template|noscript)\b[^>]*>[\s\S]*?<\/(?:template|noscript)>/gi," ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/[\s#*_`]+/g, " ")
    .trim();
}
export function canonicalPage(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Only HTTP(S) evidence URLs are accepted");
  if (url.username || url.password)
    throw new Error("Credential-bearing URLs are not accepted");
  url.hash = "";
  for (const key of [...url.searchParams.keys()])
    if (/^utm_|^(gclid|fbclid)$/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.href;
}
export function verifyBodyMatch(
  approvedBody,
  observedBody,
  { minCoverage = 0.8, minWords = 20 } = {},
) {
  const words = (value) =>
    meaningfulText(value)
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) || [];
  const approved = words(approvedBody),
    observed = words(observedBody);
  if (approved.length < minWords)
    return {
      matched: false,
      reason: "approved_body_too_short",
      coverage: null,
    };
  const shingles = (arr) =>
    new Set(arr.slice(0, -3).map((_, i) => arr.slice(i, i + 4).join(" ")));
  const a = shingles(approved),
    b = shingles(observed);
  const coverage = [...a].filter((v) => b.has(v)).length / a.size;
  return {
    matched: coverage >= minCoverage,
    reason: coverage >= minCoverage ? null : "body_mismatch",
    coverage,
    method: "approved-four-word-shingle-coverage-v1",
    approved_words: approved.length,
  };
}
export function makeSourceSnapshot({
  url,
  finalUrl = url,
  html,
  text = meaningfulText(html),
  status = 200,
  capturedAt = new Date().toISOString(),
  canonical = null,
}) {
  const body = redactSecrets(text);
  return {
    url: canonicalPage(url),
    final_url: canonicalPage(finalUrl),
    canonical: canonical
      ? canonicalPage(new URL(canonical, finalUrl).href)
      : null,
    status,
    captured_at: capturedAt,
    text: body,
    sha256: artifactHash(body),
    retrieval_observed: false,
  };
}
export function verifySourcePassage(
  snapshot,
  claim,
  { maxAgeDays = 90, now = Date.now() } = {},
) {
  if (!snapshot || snapshot.status !== 200 || !snapshot.text)
    return { verified: false, reason: "source_unavailable" };
  if (
    !Number.isFinite(Date.parse(snapshot.captured_at)) ||
    now - Date.parse(snapshot.captured_at) > maxAgeDays * 86400_000
  )
    return { verified: false, reason: "source_stale" };
  const exact = String(claim || "").trim();
  const offset = snapshot.text.indexOf(exact);
  if (exact.length < 10 || offset < 0)
    return { verified: false, reason: "support_not_found" };
  return {
    verified: true,
    source_hash: snapshot.sha256,
    quote: exact,
    start: offset,
    end: offset + exact.length,
    captured_at: snapshot.captured_at,
  };
}
export function validatePanel(input, { brandAliases = [] } = {}) {
  if (
    !input ||
    !Array.isArray(input.prompts) ||
    input.prompts.length < 1 ||
    input.prompts.length > 200
  )
    throw new Error("Provide 1–200 panel prompts");
  input = { ...input, context: resolveMeasurementContext(input.context || {}) };
  const errors = [];
  const seen = new Set();
  const prompts = input.prompts.map((p, index) => {
    const text = String(p.text || "")
      .normalize("NFKC")
      .trim();
    if (
      text.length < (p.purpose === "diagnostic" ? 2 : 8) ||
      text.length > 1500
    )
      errors.push(`Prompt ${index + 1}: invalid length`);
    const normalized = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
    if (seen.has(normalized))
      errors.push(`Prompt ${index + 1}: duplicate question`);
    seen.add(normalized);
    const branded = brandAliases.some((alias) =>
      new RegExp(
        `(^|[^\\p{L}\\p{N}])${String(alias).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}\\p{N}]|$)`,
        "iu",
      ).test(text),
    );
    const purpose = branded
      ? "diagnostic"
      : p.purpose ||
        (/\b(best|recommend|compare|which|alternative|versus| vs |buy)\b/i.test(
          text,
        )
          ? "recommendation"
          : "information");
    if (!["diagnostic", "recommendation", "information"].includes(purpose))
      errors.push(`Prompt ${index + 1}: invalid purpose`);
    const weight = p.weight == null ? 1 : Number(p.weight);
    if (!Number.isFinite(weight) || weight <= 0 || weight > 10 || weight !== 1)
      errors.push(
        `Prompt ${index + 1}: only equal question weights are supported`,
      );
    const origin = p.origin || "generated";
    if (
      ![
        "generated",
        "gsc_search",
        "customer_research",
        "licensed_panel",
        "manual",
      ].includes(origin)
    )
      errors.push(`Prompt ${index + 1}: invalid origin`);
    if (
      ["customer_research", "licensed_panel"].includes(origin) &&
      (!p.evidence_ref || !p.usage_rights)
    )
      errors.push(
        `Prompt ${index + 1}: source evidence and usage rights required`,
      );
    return {
      ...p,
      id:
        p.id ||
        artifactHash({ text, market: input.context, purpose }).slice(0, 32),
      text,
      purpose,
      weight,
      origin,
      persona: p.persona || input.persona || null,
      intent: p.intent || purpose,
      topic: p.topic || "General",
      demand_estimate: null,
    };
  });
  const nearDuplicates = [];
  for (let i = 0; i < prompts.length; i++)
    for (let j = i + 1; j < prompts.length; j++) {
      const a = new Set(prompts[i].text.toLowerCase().match(/\p{L}+/gu)),
        b = new Set(prompts[j].text.toLowerCase().match(/\p{L}+/gu));
      const overlap =
        [...a].filter((x) => b.has(x)).length / new Set([...a, ...b]).size;
      if (overlap > 0.8 && !prompts[j].duplicate_reason)
        nearDuplicates.push({
          left: prompts[i].id,
          right: prompts[j].id,
          similarity: overlap,
        });
    }
  if (errors.length) throw new Error(errors.join("; "));
  return {
    ...input,
    schema_version: WORKFLOW_VERSION,
    prompts,
    near_duplicates: nearDuplicates,
    weights_frozen: true,
    summary: prompts.reduce(
      (out, p) => ((out[p.purpose] = (out[p.purpose] || 0) + 1), out),
      {},
    ),
  };
}
export function draftCheck(draft, research, verdict) {
  return {
    schema_version: WORKFLOW_VERSION,
    content_hash: contentHash(draft.title, draft.body_md),
    research_snapshot: research || {},
    passed: verdict?.passed === true,
    issues: verdict?.issues || [],
    checked_at: new Date().toISOString(),
  };
}
export function checkMatches(item) {
  const check = item?.rubric?.check;
  return Boolean(
    check?.passed &&
      check.content_hash === contentHash(item.title, item.body_md) &&
      canonicalJson(check.research_snapshot) ===
        canonicalJson(item.research_pack || {}),
  );
}
export function opportunityFromEvidence({
  snapshot,
  passage,
  observations = [],
  ownedDomain,
  targetUrl,
  owner,
  mechanism,
  action = "owned_page_update",
}) {
  if (!owner || !mechanism || !targetUrl)
    throw new Error("Opportunity requires owner, mechanism and target URL");
  const support = verifySourcePassage(snapshot, passage);
  const unique = [
    ...new Map(
      observations
        .filter((o) => o.observation_id)
        .map((o) => [o.observation_id, o]),
    ).values(),
  ];
  const dates = new Set(
    unique.map((o) => String(o.observed_at || "").slice(0, 10)).filter(Boolean),
  );
  return {
    schema_version: WORKFLOW_VERSION,
    action,
    target_url: canonicalPage(targetUrl),
    owner,
    mechanism,
    source: snapshot,
    support,
    observations: unique.map((o) => ({
      observation_id: o.observation_id,
      prompt_id: o.prompt_id,
      surface: o.surface,
      observed_at: o.observed_at,
    })),
    evidence_status: support.verified ? "verified" : "hypothesis",
    retrieval_status: "unknown",
    decision: "unreviewed",
    score: {
      repeat_observations: unique.length,
      distinct_days: dates.size,
      verified_passage: support.verified ? 1 : 0,
    },
    expected_effect: "Hypothesis; later compatible observations required",
    owned: ownedDomain ? new URL(targetUrl).hostname === ownedDomain : false,
    retest_after: null,
    outreach_sent: false,
  };
}
