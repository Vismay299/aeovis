import { artifactHash, contentHash, verifySourcePassage } from "./workflow.js";
export function researchEvidence({
  snapshots = [],
  skipped = [],
  clientFacts = [],
} = {}) {
  const facts = clientFacts.filter(
    (f) => f && f.statement && f.approved_by && f.source_hash,
  );
  return {
    schema: "research-evidence-v1",
    snapshots,
    skipped,
    client_facts: facts,
    supported_sources: snapshots.filter((s) => s.status === 200 && s.text)
      .length,
    completeness: {
      requested: snapshots.length + skipped.length,
      captured: snapshots.length,
      failed: skipped.length,
    },
    qualification: snapshots.length || facts.length ? "sourced" : "exploratory",
    version: artifactHash({ snapshots, skipped, facts }),
  };
}
export function bindResearchCheck(ctx, verdict) {
  const evidence = ctx.researchPack?.evidence;
  const issues = [...(verdict.issues || [])];
  if (
    !evidence ||
    (!evidence.supported_sources && !evidence.client_facts?.length)
  )
    issues.push({
      kind: "missing_evidence",
      claim: "Draft grounding",
      problem:
        "No captured source or approved first-party fact supports a qualified factual draft",
    });
  return {
    ...verdict,
    passed: verdict.passed === true && issues.length === 0,
    issues,
    content_hash: contentHash(ctx.draft?.title, ctx.draft?.body_md),
    research_snapshot: ctx.researchPack || {},
    checked_at: new Date().toISOString(),
  };
}
export function isCurrentCheck(check, draft, research) {
  return Boolean(
    check &&
      check.content_hash === contentHash(draft?.title, draft?.body_md) &&
      artifactHash(check.research_snapshot) === artifactHash(research || {}),
  );
}
