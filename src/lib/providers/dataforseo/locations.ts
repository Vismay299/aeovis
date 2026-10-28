// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/shared/keyword-locations.ts, src/shared/ai-visibility.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { AppError } from "../../http/appError.ts";

export const DATAFORSEO_LOCATION_BY_COUNTRY = {
  in: 2356,
  us: 2840,
  uk: 2826,
  sg: 2702,
  ae: 2784,
  ca: 2124,
  au: 2036,
} as const;

export const ISO_BY_COUNTRY = {
  in: "IN",
  us: "US",
  uk: "GB",
  sg: "SG",
  ae: "AE",
  ca: "CA",
  au: "AU",
} as const;

export const AI_UNSUPPORTED_LOCATIONS = {
  chatgpt: [2275, 2344, 2831, 2832, 2833, 2862],
  gemini: [],
  google_ai_overview: [],
  claude: [],
  perplexity: [],
} as const;

export function dataforseoMarket(ctx: {
  country: string;
  language: string;
}): { locationCode: number; languageCode: string; isoCountry: string } {
  const country = ctx.country.trim().toLowerCase() as keyof typeof DATAFORSEO_LOCATION_BY_COUNTRY;
  const locationCode = DATAFORSEO_LOCATION_BY_COUNTRY[country];
  if (!locationCode) {
    throw new AppError(422, "dataforseo_location_unsupported", "DataForSEO does not support this market.");
  }
  return {
    locationCode,
    languageCode: ctx.language.trim() || "en",
    isoCountry: ISO_BY_COUNTRY[country],
  };
}