/**
 * Extract a human-readable message from an unknown error or return the fallback.
 * F04 version: simple Error message extraction.
 * F05 replaces this to handle SpendRefusedError and structured API errors.
 */
export function describeError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  return fallback;
}
