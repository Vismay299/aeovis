export const AIO_ERROR_RATE_LIMIT_PCT = 50;
export const AIO_MIN_NON_BRANDED_COVERAGE = 0.30;
export const AIO_MIN_NON_BRANDED_WITH_AIO = 5;
// Keep modest concurrency so Hobby-plan serverless invocations (maxDuration 60s)
// can finish a meaningful batch of Bright Data probes without stampeding the API.
export const AIO_CONCURRENCY = 4;
/** Max SERP probes per serverless invocation (resume via status poll / cron). */
export const AIO_PROBES_PER_INVOCATION = 3;
/** Dashboard coverage KPI tone: below this % is "warning" (not the reliability gate). */
export const AIO_COVERAGE_WARNING_PCT = 50;