import { isPromptRelatedToUrl } from "./topics.js";
import { measuredNumberOrNull } from "./measuredNumber.js";

function getPromptText(result) {
  return (result.prompt || result.text || "").toLowerCase().trim();
}

function getMatchesForEvent(results, eventUrl) {
  return results.filter(
    (r) =>
      isPromptRelatedToUrl(r.prompt || r.text, eventUrl) ||
      r.related_content_url === eventUrl
  );
}

/**
 * R2.9.7 — average the prompts that HAVE a score, and say so when none do.
 *
 * This used to read `acc + (m.prompt_score ?? 0)` over every match and divide by
 * `matches.length`. A result row that carries no `prompt_score` — which is every
 * row produced by the current enginePipeline, since prompt_score belongs to the
 * older aggregate path — therefore entered the mean as a hard 0 and dragged the
 * content-lift score toward zero in proportion to how many rows were unscored.
 * With no row scored at all it reported `current_score: 0`: "this page's prompts
 * score zero", said about prompts nobody scored. Same defect class as
 * enginePipeline's empty denominators; see ./measuredNumber.js.
 *
 * A row scored a genuine 0 still counts as a measurement and still pulls the
 * mean down, which is the correct behaviour and is asserted by the guard test.
 */
function avgPromptScore(matches) {
  const scored = (matches || [])
    .map((m) => measuredNumberOrNull(m && m.prompt_score))
    .filter((n) => n !== null);
  if (scored.length === 0) return null;
  const sum = scored.reduce((acc, n) => acc + n, 0);
  return Math.round((sum / scored.length) * 10) / 10;
}

export function computeContentLiftReport(event, currentResults, previousResults = []) {
  const latestMatches = getMatchesForEvent(currentResults, event.url);

  if (latestMatches.length === 0) {
    return {
      related_prompts: [],
      current_score: null,
      previous_score: null,
      lift: null,
    };
  }

  const relatedPrompts = latestMatches.map((m) => m.prompt || m.text);
  const currentScore = avgPromptScore(latestMatches);

  let previousScore = null;
  let lift = null;

  if (previousResults.length > 0) {
    const prevMatches = previousResults.filter((r) =>
      relatedPrompts.some((pText) => pText.toLowerCase().trim() === getPromptText(r))
    );

    if (prevMatches.length > 0) {
      previousScore = avgPromptScore(prevMatches);
      // R2.9.7 — a lift needs TWO measurements. `null - null` is 0 in
      // JavaScript, so once avgPromptScore learned to return null this
      // subtraction would have reported "no change at all" for a pair of
      // readings that do not exist — the fabrication moving one line down
      // rather than being removed.
      lift =
        currentScore !== null && previousScore !== null
          ? Math.round((currentScore - previousScore) * 10) / 10
          : null;
    }
  }

  return {
    related_prompts: relatedPrompts,
    current_score: currentScore,
    previous_score: previousScore,
    lift,
  };
}

export function computeContentLiftReports(events, currentResults, previousResults = []) {
  return (events || []).map((event) => ({
    ...event,
    ...computeContentLiftReport(event, currentResults, previousResults),
  }));
}