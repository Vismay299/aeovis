import { isPromptRelatedToUrl } from "./topics.js";

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

function avgPromptScore(matches) {
  if (!matches.length) return null;
  const sum = matches.reduce((acc, m) => acc + (m.prompt_score ?? 0), 0);
  return Math.round((sum / matches.length) * 10) / 10;
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
      lift = Math.round((currentScore - previousScore) * 10) / 10;
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