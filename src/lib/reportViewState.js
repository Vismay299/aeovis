export function reportResponseState(status, body) {
  if (status === 401)
    return {
      state: "authentication_required",
      retryable: false,
      message: "Sign in to view reports available to your account.",
    };
  if (status === 403 || status === 404)
    return {
      state: "unavailable",
      retryable: false,
      message:
        "This report is unavailable. Check your account access or return to workspace history.",
    };
  if (status === 410)
    return {
      state: "expired",
      retryable: true,
      message:
        "This evidence link has expired. Request a fresh link; the measurement is unchanged.",
    };
  if (status < 200 || status >= 300)
    return {
      state: "backend_error",
      retryable: status >= 500 || status === 429,
      message: `The report could not be loaded (HTTP ${status}). Retry this report.`,
    };
  const scan = body?.scan;
  if (
    !scan ||
    typeof scan !== "object" ||
    !scan.id ||
    (!scan.raw_results && !scan.summary_stats && !Array.isArray(scan.results))
  )
    return {
      state: "contract_error",
      retryable: true,
      message: "The server returned an unreadable report. Retry this report.",
    };
  const outcome =
    scan.summary_stats?.terminal_outcome ||
    scan.raw_results?.summary_stats?.terminal_outcome;
  return {
    state: outcome && outcome.outcome !== "complete" ? "partial" : "available",
    scan,
    retryable: false,
    message: null,
  };
}
export function offlineReportState() {
  return {
    state: "offline",
    retryable: true,
    message:
      "The report could not be reached. Check your connection and retry this report.",
  };
}
