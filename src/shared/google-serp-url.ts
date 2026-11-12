// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/shared/google-serp-url.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { getIsoCountryCode } from "./keyword-locations.ts";

type SerpMarket = { locationCode: number; languageCode: string; locationName?: string | null };

function encodeUule(canonicalName: string): string {
  const name = new TextEncoder().encode(canonicalName);
  const length = name.length < 0x80 ? [name.length] : [(name.length & 0x7f) | 0x80, name.length >> 7];
  const bytes = [0x08, 0x02, 0x10, 0x20, 0x22, ...length, ...name];
  return btoa(String.fromCharCode(...bytes));
}

export function googleSerpUrl(keyword: string, market: SerpMarket): string {
  const params = new URLSearchParams({
    q: keyword,
    hl: market.languageCode,
    gl: getIsoCountryCode(market.locationCode),
    pws: "0",
  });
  const uule = market.locationName ? `&uule=w+${encodeURIComponent(encodeUule(market.locationName))}` : "";
  return `https://www.google.com/search?${params.toString()}${uule}`;
}
