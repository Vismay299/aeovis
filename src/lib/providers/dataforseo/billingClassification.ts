// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/dataforseoBillingClassification.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { UnbilledCallError } from "../../spend/errors.ts";
import type { DataforseoErrorClassifier } from "./core.ts";

const BILLING_SIGNALS = [
  "insufficient funds",
  "balance is too low",
  "payment required",
  "billing",
  "balance",
  "problem billing",
  "recharged",
];

const BILLING_STATUS_CODES = new Set([40200, 40210, 402]);

export function createDataforseoBillingClassifier(config: {
  pathPrefix: string;
  billingIssueCode: string;
  billingIssueMessage: string;
}): DataforseoErrorClassifier {
  return (status, details, path) => {
    if (!path.includes(config.pathPrefix)) return null;
    const text = details.toLowerCase();
    const billingStatus = status != null && BILLING_STATUS_CODES.has(status);
    if (billingStatus || BILLING_SIGNALS.some((signal) => text.includes(signal))) {
      const providerCode = status === undefined
        ? undefined
        : status === 402
        ? "dataforseo_http_402"
        : `dataforseo_${status}`;
      return new UnbilledCallError(config.billingIssueMessage, {
        status: 402,
        code: config.billingIssueCode,
        details: providerCode ? { providerCode } : undefined,
      });
    }
    return null;
  };
}
