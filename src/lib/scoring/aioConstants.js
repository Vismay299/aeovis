export const AIO_ERROR_RATE_LIMIT_PCT = 50;
// India AIO coverage is lower/volatile than US — 30% was too strict and
// flagged healthy scans as a data-source issue.
export const AIO_MIN_NON_BRANDED_COVERAGE = 0.15;
export const AIO_MIN_NON_BRANDED_WITH_AIO = 5;
// 34 queries at ~45-60s each: concurrency 3 => ~10-12 min (butts against the
// client's poll timeout). 6 halves it to ~5-6 min. Bright Data retries 429s
// with backoff internally, so this stays within a single SERP zone's limits.
export const AIO_CONCURRENCY = 6;
/** Dashboard coverage KPI tone: below this % is "warning" (not the reliability gate). */
export const AIO_COVERAGE_WARNING_PCT = 30;