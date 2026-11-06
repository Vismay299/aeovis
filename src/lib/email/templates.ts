import { AppError } from "../http/errors.ts";
import { skipReasonMessage } from "../../shared/schedule.ts";
import type { TransactionalTemplate } from "./types.ts";

export const TEMPLATE_KEYS: Record<TransactionalTemplate, readonly string[]> = {
  scan_finished: [
    "brandName",
    "scanDate",
    "questionsAsked",
    "questionsNamingYou",
    "outcomeLabel",
    "reportUrl",
    "unsubscribeUrl",
  ],
  schedule_skipped: [
    "brandName",
    "windowTime",
    "reasonMessage",
    "actionLabel",
    "actionUrl",
    "nextRunTime",
    "unsubscribeUrl",
  ],
  spend_cap_reached: [
    "brandName",
    "periodLabel",
    "limitUsd",
    "resumesOn",
    "usageUrl",
    "unsubscribeUrl",
  ],
};

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function formatDateUtc(d: Date): string {
  return `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function formatDateTimeUtc(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${formatDateUtc(d)}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

export function getNextUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
}

export function getFirstOfNextUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

const TEMPLATE_VALUE_PATTERNS: Record<string, (val: string) => boolean> = {
  brandName: (v) => v.length > 0 && v.length <= 120,
  scanDate: (v) => /^\d{1,2} [A-Z][a-z]{2} \d{4}$/.test(v),
  questionsAsked: (v) => /^(\d{1,4}|Not measured)$/.test(v),
  questionsNamingYou: (v) => /^(\d{1,4}|Not measured)$/.test(v),
  outcomeLabel: (v) => v === "Complete" || v === "Partial — some answers could not be collected",
  reportUrl: (v) => /^https?:\/\/.+/.test(v),
  unsubscribeUrl: (v) => /^https?:\/\/.+/.test(v),
  windowTime: (v) => /^\d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} UTC$/.test(v),
  reasonMessage: (v) => v.length > 0 && v.length <= 200,
  actionLabel: (v) => v.length > 0 && v.length <= 200,
  actionUrl: (v) => /^https?:\/\/.+/.test(v),
  nextRunTime: (v) => v === "Not scheduled" || /^\d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} UTC$/.test(v),
  periodLabel: (v) => v === "daily" || v === "monthly",
  limitUsd: (v) => v === "your limit" || /^\$\d{1,6}\.\d{2}$/.test(v),
  resumesOn: (v) => /^\d{1,2} [A-Z][a-z]{2} \d{4}$/.test(v),
  usageUrl: (v) => /^https?:\/\/.+/.test(v),
};

export function validateTemplateData(
  template: string,
  data: unknown,
): asserts data is Record<string, string> {
  if (
    !template ||
    !(template in TEMPLATE_KEYS) ||
    typeof data !== "object" ||
    data === null ||
    Array.isArray(data)
  ) {
    throw new AppError(500, "email_data_invalid", "Invalid email template or data object");
  }

  const txTemplate = template as TransactionalTemplate;
  const allowedKeys = new Set(TEMPLATE_KEYS[txTemplate]);
  const entries = Object.entries(data as Record<string, unknown>);

  for (const [key, val] of entries) {
    if (!allowedKeys.has(key)) {
      throw new AppError(500, "email_data_invalid", `Unknown key '${key}' for template '${template}'`);
    }
    if (typeof val !== "string") {
      throw new AppError(500, "email_data_invalid", `Key '${key}' must be a string`);
    }
    if (val.length > 200) {
      throw new AppError(500, "email_data_invalid", `Value for '${key}' exceeds 200 characters`);
    }
    const validator = TEMPLATE_VALUE_PATTERNS[key];
    if (validator && !validator(val)) {
      throw new AppError(500, "email_data_invalid", `Value for '${key}' failed pattern validation: '${val}'`);
    }
  }

  // Ensure all allowed template keys are present
  for (const key of allowedKeys) {
    if (!(key in (data as Record<string, unknown>))) {
      throw new AppError(500, "email_data_invalid", `Missing required key '${key}' for template '${template}'`);
    }
  }
}

export function buildScanFinishedData(
  scan: {
    id: string;
    created_at?: string | Date | null;
    prompts_tracked?: number | null;
    prompts_mentioned?: number | null;
    raw_results?: {
      summary_stats?: {
        terminal_outcome?: {
          outcome?: string;
        };
      };
    } | null;
  },
  brand: { brand_key: string; display_name?: string | null; name?: string | null },
  links: { appUrl?: string; reportUrl?: string; unsubscribeUrl?: string },
): Record<string, string> {
  const brandName = (brand.display_name || brand.name || brand.brand_key).slice(0, 120);
  const scanDate = formatDateUtc(new Date(scan.created_at || Date.now()));
  const questionsAsked =
    scan.prompts_tracked != null ? String(scan.prompts_tracked) : "Not measured";
  const questionsNamingYou =
    scan.prompts_mentioned != null ? String(scan.prompts_mentioned) : "Not measured";
  const terminalOutcome = scan.raw_results?.summary_stats?.terminal_outcome?.outcome;
  const outcomeLabel =
    terminalOutcome === "complete"
      ? "Complete"
      : "Partial — some answers could not be collected";

  const appUrl = (links.appUrl ?? "https://perceev.com").replace(/\/+$/, "");
  const reportUrl = links.reportUrl ?? `${appUrl}/portal/scans/${scan.id}`;
  const unsubscribeUrl = links.unsubscribeUrl ?? `${appUrl}/portal/settings/notifications`;

  const data = {
    brandName,
    scanDate,
    questionsAsked,
    questionsNamingYou,
    outcomeLabel,
    reportUrl,
    unsubscribeUrl,
  };
  validateTemplateData("scan_finished", data);
  return data;
}

export function buildScheduleSkippedData(
  window: {
    recorded_at?: string | Date | null;
    window_time?: string | Date | null;
    reason?: string | null;
  },
  brand: { brand_key: string; display_name?: string | null; name?: string | null },
  nextRunAt: Date | string | null | undefined,
  links: { appUrl?: string; actionUrl?: string; unsubscribeUrl?: string },
): Record<string, string> {
  const brandName = (brand.display_name || brand.name || brand.brand_key).slice(0, 120);
  const rawDate = window.window_time || window.recorded_at || new Date();
  const windowTime = formatDateTimeUtc(new Date(rawDate));
  const reason = window.reason || "start_failed";
  const reasonMessage = skipReasonMessage(reason);

  let actionLabel = "View schedule";
  let defaultActionPath = "/portal/settings/schedule";
  if (reason === "panel_not_approved") {
    actionLabel = "Approve your questions";
    defaultActionPath = "/portal/measurement";
  } else if (reason === "price_changed" || reason === "over_scan_limit") {
    actionLabel = "Review the price";
    defaultActionPath = "/portal/settings/schedule";
  }

  const appUrl = (links.appUrl ?? "https://perceev.com").replace(/\/+$/, "");
  const actionUrl = links.actionUrl ?? `${appUrl}${defaultActionPath}`;
  const nextRunTime = nextRunAt ? formatDateTimeUtc(new Date(nextRunAt)) : "Not scheduled";
  const unsubscribeUrl = links.unsubscribeUrl ?? `${appUrl}/portal/settings/notifications`;

  const data = {
    brandName,
    windowTime,
    reasonMessage,
    actionLabel,
    actionUrl,
    nextRunTime,
    unsubscribeUrl,
  };
  validateTemplateData("schedule_skipped", data);
  return data;
}

export function buildSpendCapData(
  i: {
    reason: "daily_cap" | "workspace_cap";
    limitUsd?: number | null;
    now?: Date | string | null;
    usagePageEnabled?: boolean;
  },
  brand: { brand_key: string; display_name?: string | null; name?: string | null },
  links: { appUrl?: string; usageUrl?: string; unsubscribeUrl?: string },
): Record<string, string> {
  const brandName = (brand.display_name || brand.name || brand.brand_key).slice(0, 120);
  const periodLabel = i.reason === "daily_cap" ? "daily" : "monthly";
  const limitUsd =
    i.limitUsd != null && !Number.isNaN(Number(i.limitUsd))
      ? `$${Number(i.limitUsd).toFixed(2)}`
      : "your limit";

  const baseDate = i.now ? new Date(i.now) : new Date();
  const resumesDate =
    i.reason === "daily_cap"
      ? getNextUtcDay(baseDate)
      : getFirstOfNextUtcMonth(baseDate);
  const resumesOn = formatDateUtc(resumesDate);

  const appUrl = (links.appUrl ?? "https://perceev.com").replace(/\/+$/, "");
  const defaultUsagePath = i.usagePageEnabled ? "/portal/usage" : "/portal";
  const usageUrl = links.usageUrl ?? `${appUrl}${defaultUsagePath}`;
  const unsubscribeUrl = links.unsubscribeUrl ?? `${appUrl}/portal/settings/notifications`;

  const data = {
    brandName,
    periodLabel,
    limitUsd,
    resumesOn,
    usageUrl,
    unsubscribeUrl,
  };
  validateTemplateData("spend_cap_reached", data);
  return data;
}
