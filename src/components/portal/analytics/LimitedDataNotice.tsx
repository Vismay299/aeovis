"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";

/** The shared sampling / thresholding / "(other)" row notice (§6.6.3). */
export function LimitedDataNotice() {
  return (
    <Alert>
      <AlertDescription>
        Google Analytics limited this report (sampling, thresholding or an
        “(other)” row), so numbers may be lower than in Analytics.
      </AlertDescription>
    </Alert>
  );
}
