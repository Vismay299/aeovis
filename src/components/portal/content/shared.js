/**
 * Shared helpers for the Content Studio portal page: the customer API client,
 * playbook labels and small text utilities. No React here.
 */
import { FORMATS } from "../../../lib/content/agents/formats.js";

export const cx = (...parts) => parts.filter(Boolean).join(" ");

export const PLAYBOOK_OPTIONS = [
  { value: "geo_article", label: "Article (GEO)" },
  { value: "linkedin_post", label: "LinkedIn post" },
];

export function playbookLabel(value, format) {
  if (FORMATS[format]) return FORMATS[format].label;
  return PLAYBOOK_OPTIONS.find((option) => option.value === value)?.label || "";
}

export class ContentApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ContentApiError";
    this.status = status;
  }
}

/**
 * Calls a customer content route. brand_key goes in the query string (read by
 * GET/PATCH routes) and in the JSON body (read by POST routes). Throws
 * ContentApiError with `status`; 401 means the session expired.
 */
export async function contentRequest(path, { brandKey, method = "GET", body } = {}) {
  const url = new URL(path, window.location.origin);
  url.searchParams.set("brand_key", brandKey);
  const init = { method, cache: "no-store" };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify({ ...body, brand_key: brandKey });
  }
  let response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new ContentApiError("Could not reach the server. Check your connection and try again.", 0);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ContentApiError(data.error || "Request failed.", response.status);
  return data;
}

export function countWords(text) {
  const trimmed = String(text || "").trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

export function readingMinutes(words) {
  return Math.max(1, Math.ceil(words / 230));
}
