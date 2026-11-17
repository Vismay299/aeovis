/**
 * Normalizes a topic name string.
 * NOTE: We chose Title Case over raw slugification for optimal display readability
 * in dashboards, table headers, and insight summaries.
 * Trims whitespace, capitalizes the first letter of each word (Title Case),
 * and handles fallbacks.
 *
 * @param {string} name - Topic name input
 * @returns {string} Clean normalized topic name
 */
export function normalizeTopic(name) {
  if (!name || typeof name !== "string") {
    return "General";
  }

  const trimmed = name.trim();
  if (!trimmed) {
    return "General";
  }

  // Capitalize first letter of each word, lower-casing the rest
  return trimmed
    .split(/\s+/)
    .map(word => {
      if (!word) return "";
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .filter(Boolean)
    .join(" ");
}

/**
 * Helper to convert a topic name into a URL-friendly slug if needed.
 *
 * @param {string} name - Topic name input
 * @returns {string} Lowercase slug
 */
export function slugifyTopic(name) {
  return normalizeTopic(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/**
 * Determines if a query prompt is semantically related to a content URL path.
 * Match criteria: parses the path segments, extracts key terms (excluding stopwords),
 * and checks if those terms are present in the query string.
 *
 * @param {string} promptText - Query prompt string
 * @param {string} urlStr - Content event URL string
 * @returns {boolean} True if matching/related
 */
export function isPromptRelatedToUrl(promptText, urlStr) {
  if (!promptText || !urlStr) return false;
  try {
    const cleanedUrl = urlStr.replace(/^https?:\/\//i, '').replace(/\/$/, '');
    const parts = cleanedUrl.split('/');
    if (parts.length <= 1) return false; // Domain only, no path to match against
    
    const pathSegments = parts.slice(1).join(' ').toLowerCase();
    const promptLower = promptText.toLowerCase();
    
    const keywords = pathSegments.split(/[^a-z0-9]/).filter(w => w.length > 2);
    if (keywords.length === 0) return false;
    
    const stopwords = new Set(["the", "and", "for", "with", "how", "what", "why", "best", "top", "free", "blog", "post"]);
    const queryKeywords = keywords.filter(k => !stopwords.has(k));
    
    if (queryKeywords.length === 0) return false;
    
    return queryKeywords.some(k => promptLower.includes(k));
  } catch (e) {
    return false;
  }
}

