// Estimator for Firecrawl scrape calls (F08 §6.2.10, Risk 3)

export const FIRECRAWL_SCRAPE_USD_DEFAULT = 0.005;

export function firecrawlScrapeUsd(env: Record<string, string | undefined> = process.env): number {
  const raw = env.FIRECRAWL_SCRAPE_USD;
  if (raw !== undefined && raw !== "") {
    const val = Number(raw);
    if (Number.isFinite(val) && val > 0) {
      return val;
    }
  }
  return FIRECRAWL_SCRAPE_USD_DEFAULT;
}
