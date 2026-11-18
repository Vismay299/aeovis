// F23 §6.6 — what a report's share state looks like after a share or unshare
// response. Pure, so the rules below are tested without a browser.

export type ShareFields = {
  shared: boolean;
  shareToken: string | null;
  sharedAt: string | null;
  views30d: number | null;
};

export type ShareResult = {
  shareToken: string | null;
  sharedAt: string | null;
};

/**
 * The report with the share response applied. Views belong to one link:
 * turning sharing off clears the count, and a link minted after a revoke is a
 * different link that nobody has opened yet, so it starts at zero. Only a
 * response naming the link already on the page keeps its count.
 */
export function applyShareResult<T extends ShareFields>(
  report: T,
  result: ShareResult,
): T {
  let views30d: number | null = 0;
  if (result.shareToken === null) views30d = null;
  else if (result.shareToken === report.shareToken) views30d = report.views30d;
  return {
    ...report,
    shareToken: result.shareToken,
    sharedAt: result.sharedAt,
    shared: result.shareToken !== null,
    views30d,
  };
}

/** "Opened 1 time" / "Opened 5 times", for the share dialog's footnote. */
export function describeViews(views30d: number): string {
  return `Opened ${views30d} ${views30d === 1 ? "time" : "times"} in the last 30 days.`;
}
