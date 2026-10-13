import { Banner } from "../ui";

/** These findings describe the generated version, not subsequent human edits. */
export default function ReviewFindings({ rubric }) {
  if (!rubric || typeof rubric !== "object" || !rubric.verdict) return null;
  const flagged = rubric.below_threshold || rubric.ymyl_violation || rubric.verdict !== "pass";
  const violations = Array.isArray(rubric.violations) ? rubric.violations : [];
  const score = typeof rubric.weighted_total === "number" && Number.isFinite(rubric.weighted_total)
    ? `${Math.round(rubric.weighted_total * 100)} / 100` : null;
  return (
    <section className="pv-content-review" aria-label="Generation review">
      <Banner tone={rubric.ymyl_violation ? "error" : flagged ? "warn" : "info"}
        title={rubric.ymyl_violation ? "Sensitive claims flagged" : flagged ? "Generated draft needs corrections" : "Generated draft passed automated review"}>
        {score ? `Review score: ${score}. ` : ""}
        {flagged ? "Read the findings before approving this draft." : "Your review is still required before approval."}
      </Banner>
      <p className="pv-content-review__note">These checks describe the generated version. Review any later edits separately.</p>
      {violations.length || rubric.critique ? (
        <details open={Boolean(flagged)}>
          <summary>Reviewer findings{violations.length ? ` (${violations.length})` : ""}</summary>
          {violations.length ? <ul>{violations.map((finding, index) => (
            <li key={index}><strong>{finding.rule || "Review finding"}</strong>{finding.ymyl ? " · Sensitive claim" : ""}<p>{finding.detail}</p></li>
          ))}</ul> : null}
          {rubric.critique ? <p className="pv-content-review__critique">{rubric.critique}</p> : null}
        </details>
      ) : null}
    </section>
  );
}
