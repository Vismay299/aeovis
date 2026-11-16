import { Banner } from "../ui";

/** These findings describe the generated version, not subsequent human edits. */
export default function ReviewFindings({ rubric }) {
  if (!rubric || typeof rubric !== "object" || !rubric.verdict) return null;
  const flagged = rubric.below_threshold || rubric.ymyl_violation || rubric.verdict !== "pass";
  const violations = Array.isArray(rubric.violations) ? rubric.violations : [];
  const score = typeof rubric.weighted_total === "number" && Number.isFinite(rubric.weighted_total)
    ? `${Math.round(rubric.weighted_total * 100)} / 100` : null;
  return (
    <section className="space-y-2.5 px-4 pt-4" aria-label="Generation review">
      <Banner tone={rubric.ymyl_violation ? "error" : flagged ? "warn" : "info"}
        title={rubric.ymyl_violation ? "Sensitive claims flagged" : flagged ? "Generated draft needs corrections" : "Generated draft passed automated review"}>
        {score ? `Review score: ${score}. ` : ""}
        {flagged ? "Read the findings before approving this draft." : "Your review is still required before approval."}
      </Banner>
      <p className="text-xs text-muted-foreground">These checks describe the generated version. Review any later edits separately.</p>
      {violations.length || rubric.critique ? (
        <details open={Boolean(flagged)} className="text-sm [&_summary]:cursor-pointer [&_summary]:font-semibold">
          <summary>Reviewer findings{violations.length ? ` (${violations.length})` : ""}</summary>
          {violations.length ? <ul className="mt-3 space-y-3 text-sm leading-relaxed">{violations.map((finding, index) => (
            <li key={index}><strong>{finding.rule || "Review finding"}</strong>{finding.ymyl ? " · Sensitive claim" : ""}<p className="mt-1">{finding.detail}</p></li>
          ))}</ul> : null}
          {rubric.critique ? <p className="whitespace-pre-wrap text-sm leading-relaxed">{rubric.critique}</p> : null}
        </details>
      ) : null}
    </section>
  );
}
