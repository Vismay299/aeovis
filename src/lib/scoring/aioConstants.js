export const AIO_ERROR_RATE_LIMIT_PCT = 50;
// India AIO coverage is lower/volatile than US — 30% was too strict and
// flagged healthy scans as a data-source issue.
export const AIO_MIN_NON_BRANDED_COVERAGE = 0.15;
export const AIO_MIN_NON_BRANDED_WITH_AIO = 5;
export const AIO_CONCURRENCY = 3;
/** Dashboard coverage KPI tone: below this % is "warning" (not the reliability gate). */
export const AIO_COVERAGE_WARNING_PCT = 30;