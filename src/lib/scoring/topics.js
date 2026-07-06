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
